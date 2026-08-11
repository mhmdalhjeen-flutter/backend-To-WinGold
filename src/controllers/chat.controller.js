const Conversation = require("../models/conversationChat");
const Message      = require("../models/message");
const cache = require("../utils/responseCache.util");
const {
    normalizeContext,
    mergeReferencedItem,
    enrichConversation,
    stripChatListImages,
} = require("../utils/chatContext.util");
const { processDataUrlImage } = require("../utils/imageProcess.util");
const { safeLog } = require("../utils/logSanitize.util");
const { assertNoMongoOperators, cleanString, requireObjectId } = require("../utils/inputSecurity.util");
const { sanitizeChatParticipant } = require("../utils/userSanitize.util");
const chatNotificationService = require("../services/chatNotification.service");

const CHAT_TEXT_MAX = 2000;
const CHAT_PARTICIPANT_SELECT = "name phone whatsapp avatar";

function invalidateChatUnreadForParticipants(participants) {
    (participants || []).forEach((p) => {
        cache.invalidate(`chat:unread:${p.toString()}`);
    });
}


// ===== قائمة الكلمات المحظورة =====
const BAD_WORDS = [
    "كلمة1", "كلمة2", // أضف الكلمات التي تريد حجبها
    "stupid", "idiot", "damn",
];

const filterText = (text) => {
    if (!text) return text;
    let filtered = text;
    BAD_WORDS.forEach(word => {
        const regex = new RegExp(word, "gi");
        filtered = filtered.replace(regex, "*".repeat(word.length));
    });
    return filtered;
};

// جلب أو إنشاء محادثة
exports.getOrCreateConversation = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "chat");
        const recipientId = requireObjectId(req.body.recipientId, "recipientId");
        const { context } = req.body;
        const myId = req.user.id;

        if (recipientId.toString() === myId.toString())
            return res.status(400).json({ message: "لا يمكن إنشاء محادثة مع نفسك" });

        let conv = await Conversation.findOne({
            participants: { $all: [myId, recipientId] },
        })
        .populate("participants", CHAT_PARTICIPANT_SELECT)
        .populate("lastMessage");

        const normalized = normalizeContext(context);
        if (normalized?.itemImage) {
            normalized.itemImage = await processDataUrlImage(normalized.itemImage, { thumbnail: true });
        }

        if (!conv) {
            const referencedItems = normalized
                ? [{ ...normalized, addedAt: new Date() }]
                : [];

            conv = await Conversation.create({
                participants:    [myId, recipientId],
                context:         normalized || {},
                referencedItems,
                unreadCount:     { [myId]: 0, [recipientId]: 0 },
            });
            await conv.populate("participants", CHAT_PARTICIPANT_SELECT);
        } else if (normalized) {
            conv.referencedItems = mergeReferencedItem(conv.referencedItems, normalized);
            conv.context = normalized;
            conv.updatedAt = new Date();
            await conv.save();
            await conv.populate("participants", CHAT_PARTICIPANT_SELECT);
            await conv.populate("lastMessage");
        }

        const enriched = enrichConversation(conv);
        if (Array.isArray(enriched.participants)) {
            enriched.participants = enriched.participants.map(sanitizeChatParticipant);
        }
        res.json({ conversation: enriched });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// جلب كل المحادثات
exports.getMyConversations = async (req, res) => {
    try {
        const convs = await Conversation.find({ participants: req.user.id })
            .populate("participants", CHAT_PARTICIPANT_SELECT)
            .populate({ path: "lastMessage", select: "text createdAt read sender" })
            .sort({ updatedAt: -1 })
            .lean();
        res.json({ conversations: convs.map((c) => {
            const enriched = stripChatListImages(enrichConversation(c));
            if (Array.isArray(enriched.participants)) {
                enriched.participants = enriched.participants.map(sanitizeChatParticipant);
            }
            if (Array.isArray(enriched.participants)) {
                enriched.participants = enriched.participants.map((p) => {
                    if (typeof p?.avatar === "string" && p.avatar.startsWith("data:")) {
                        return { ...p, hasAvatar: true, avatar: null };
                    }
                    return p;
                });
            }
            return enriched;
        }) });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.getUnreadCount = async (req, res) => {
    try {
        const uid = req.user.id.toString();
        const [result] = await Conversation.aggregate([
            { $match: { participants: req.user.id } },
            {
                $project: {
                    unread: {
                        $let: {
                            vars: {
                                entry: {
                                    $arrayElemAt: [
                                        {
                                            $filter: {
                                                input: { $objectToArray: { $ifNull: ["$unreadCount", {}] } },
                                                as: "item",
                                                cond: { $eq: ["$$item.k", uid] },
                                            },
                                        },
                                        0,
                                    ],
                                },
                            },
                            in: { $ifNull: ["$$entry.v", 0] },
                        },
                    },
                },
            },
            { $group: { _id: null, total: { $sum: "$unread" } } },
        ]);
        res.json({ count: result?.total || 0 });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// جلب الرسائل
exports.getMessages = async (req, res) => {
    try {
        const convId = requireObjectId(req.params.convId, "convId");
        const page  = parseInt(req.query.page, 10)  || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

        const conv = await Conversation.findOne({
            _id: convId, participants: req.user.id,
        });
        if (!conv) return res.status(403).json({ message: "غير مسموح" });

        const messages = await Message.find({ conversation: convId })
            .populate("sender", "name avatar")
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        await Message.updateMany(
            { conversation: convId, sender: { $ne: req.user.id }, read: false },
            { $set: { read: true } }
        );
        conv.unreadCount.set(req.user.id.toString(), 0);
        await conv.save();
        invalidateChatUnreadForParticipants(conv.participants);

        res.json({ messages: messages.reverse() });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// إرسال رسالة — مع صورة وتعليق وفلتر
exports.sendMessage = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "chat");
        const convId = requireObjectId(req.params.convId, "convId");
        const { image, replyTo } = req.body;
        const text = req.body.text != null
            ? cleanString(req.body.text, { field: "text", max: CHAT_TEXT_MAX })
            : "";

        if (!text?.trim() && !image)
            return res.status(400).json({ message: "أرسل نصاً أو صورة" });

        const conv = await Conversation.findOne({
            _id: convId,
            participants: req.user.id,
        });
        if (!conv) return res.status(403).json({ message: "غير مسموح" });

        const msgData = {
            conversation: convId,
            sender:       req.user.id,
            text:         filterText(text.trim()) || "",
            image:        image ? await processDataUrlImage(image, { maxWidth: 800 }) : null,
            replyTo:      replyTo ? {
                messageId:  replyTo.messageId,
                text:       replyTo.text       || null,
                senderName: replyTo.senderName || null,
            } : { messageId: null, text: null, senderName: null },
        };

        const msg = await Message.create(msgData);

        conv.lastMessage = msg._id;
        conv.updatedAt   = new Date();
        conv.participants.forEach(p => {
            const pid = p.toString();
            if (pid !== req.user.id.toString()) {
                conv.unreadCount.set(pid, (conv.unreadCount.get(pid) || 0) + 1);
            }
        });
        await conv.save();
        invalidateChatUnreadForParticipants(conv.participants);

        const populated = await Message.findById(msg._id)
            .populate("sender", "name avatar");

        const recipientId = conv.participants.find(
            (p) => String(p._id || p) !== String(req.user.id)
        );
        if (recipientId) {
            chatNotificationService.notifyChatMessage({
                conversationId: convId,
                senderId: req.user.id,
                senderName: populated?.sender?.name || req.user.name || "",
                recipientId: recipientId._id || recipientId,
                text: msgData.text,
                image: msgData.image,
            }).catch(() => {});
        }

        res.status(201).json({ message: populated });
    } catch (err) {
        safeLog("error", "chat_send_failed", { message: err.message, userId: req.user?.id });
        if (err.status) return res.status(err.status).json({ message: err.message });
        res.status(500).json({ message: "تعذّر إرسال الرسالة" });
    }
};