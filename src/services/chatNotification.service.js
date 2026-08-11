const User = require("../models/user");
const notificationService = require("./notification.service");
const { safeLog } = require("../utils/logSanitize.util");

function resolveChatPushApp(role) {
  switch (role) {
    case "store":
    case "supplier":
      return "store";
    case "delivery_company":
    case "delivery_driver":
      return "delivery";
    case "admin":
      return "admin";
    default:
      return "customer";
  }
}

function resolveChatDeepLink(pushApp, { conversationId, senderId, recipientRole }) {
  const convId = conversationId ? String(conversationId) : "";
  const peerId = senderId ? String(senderId) : "";

  switch (pushApp) {
    case "delivery":
      if (recipientRole === "delivery_driver") {
        return peerId ? `/driver/chat/${peerId}` : "/driver";
      }
      return peerId ? `/chat/${peerId}` : "/chats";
    case "store":
      return convId ? `/store/chat/${convId}` : "/store/chats";
    case "admin":
      return convId ? `/chat/${convId}` : "/chats";
    default:
      return convId ? `/chat/${convId}` : "/chat";
  }
}

function previewMessage(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "رسالة جديدة";
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

async function notifyChatMessage({
  conversationId,
  senderId,
  senderName,
  recipientId,
  text,
  image,
}) {
  if (!recipientId || !conversationId) return null;
  if (String(recipientId) === String(senderId)) return null;

  try {
    const recipient = await User.findById(recipientId).select("role").lean();
    if (!recipient) return null;

    const pushApp = resolveChatPushApp(recipient.role);
    const url = resolveChatDeepLink(pushApp, {
      conversationId,
      senderId,
      recipientRole: recipient.role,
    });
    const body = image ? "📷 صورة" : previewMessage(text);
    const title = senderName ? `رسالة من ${senderName}` : "رسالة جديدة";

    return await notificationService.create({
      user: recipientId,
      type: "chat_message",
      title,
      body,
      data: {
        type: "chat_message",
        conversationId: String(conversationId),
        senderId: senderId ? String(senderId) : "",
        recipientRole: recipient.role,
        url,
        pushApp,
      },
    });
  } catch (err) {
    safeLog("warn", "chat_notify_failed", {
      message: err.message,
      conversationId: String(conversationId),
      recipientId: String(recipientId),
    });
    return null;
  }
}

module.exports = {
  notifyChatMessage,
  resolveChatPushApp,
  resolveChatDeepLink,
  previewMessage,
};
