const normalizeContext = (ctx) => {
    if (!ctx?.itemId || !ctx?.itemType) return null;
    return {
        itemId:    ctx.itemId,
        itemType:  ctx.itemType,
        itemName:  ctx.itemName || '',
        itemImage: ctx.itemImage || '',
    };
};

const itemKey = (item) => `${item.itemType}:${String(item.itemId)}`;

const mergeReferencedItem = (items, newItem) => {
    if (!newItem) return items || [];
    const key = itemKey(newItem);
    const rest = (items || []).filter((i) => itemKey(i) !== key);
    return [{ ...newItem, addedAt: new Date() }, ...rest].slice(0, 25);
};

const getReferencedItems = (conv) => {
    const plain = conv?.referencedItems?.length
        ? conv.referencedItems.map((i) => ({
            itemId:    i.itemId,
            itemType:  i.itemType,
            itemName:  i.itemName || '',
            itemImage: i.itemImage || '',
            addedAt:   i.addedAt,
        }))
        : [];

    if (plain.length) return plain;

    const ctx = normalizeContext(conv?.context);
    if (!ctx) return [];
    return [{ ...ctx, addedAt: conv.createdAt || new Date() }];
};

const enrichConversation = (conv) => {
    const obj = conv.toObject ? conv.toObject() : { ...conv };
    obj.referencedItems = getReferencedItems(obj);
    const latest = obj.referencedItems[0];
    if (latest) {
        obj.context = {
            itemId:    latest.itemId,
            itemType:  latest.itemType,
            itemName:  latest.itemName,
            itemImage: latest.itemImage,
        };
    }
    return obj;
};

const { sanitizeStoredImageUrl } = require("./blockedImageUrl.util");

const stripDataUrl = (value) => {
  const raw = typeof value === "string" && value.startsWith("data:") ? null : (value || "");
  return sanitizeStoredImageUrl(raw) ?? "";
};

/** قوائم المحادثات — لا base64 في الصور المرجعية أو آخر رسالة */
const stripChatListImages = (conv) => {
    const obj = { ...conv };
    if (obj.lastMessage?.image) {
        const hasImage = typeof obj.lastMessage.image === "string" && obj.lastMessage.image.startsWith("data:");
        obj.lastMessage = {
            ...obj.lastMessage,
            hasImage: hasImage || !!obj.lastMessage.image,
            image: stripDataUrl(obj.lastMessage.image) || null,
        };
    }
    if (obj.context?.itemImage) {
        obj.context = {
            ...obj.context,
            hasItemImage: !!obj.context.itemImage && !obj.context.itemImage.startsWith("data:"),
            itemImage: stripDataUrl(obj.context.itemImage),
        };
    }
    if (Array.isArray(obj.referencedItems)) {
        obj.referencedItems = obj.referencedItems.map((item) => ({
            ...item,
            hasItemImage: !!item.itemImage && !String(item.itemImage).startsWith("data:"),
            itemImage: stripDataUrl(item.itemImage),
        }));
    }
    return obj;
};

module.exports = {
    normalizeContext,
    mergeReferencedItem,
    getReferencedItems,
    enrichConversation,
    stripChatListImages,
};
