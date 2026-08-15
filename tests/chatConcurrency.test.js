/**
 * Chat messaging concurrency — run with:
 * node --test --test-force-exit tests/chatConcurrency.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const convId = new mongoose.Types.ObjectId();
const senderId = new mongoose.Types.ObjectId();
const recipientId = new mongoose.Types.ObjectId();
const messageId = new mongoose.Types.ObjectId();

let updateOneCalls = 0;
let messageCreateCalls = 0;
let messageDeleteCalls = 0;
let updateManyCalls = 0;
let simulatedUpdateOneFailures = 0;
let createdMessages = [];

function versionError() {
  const err = new Error("No matching document found for id");
  err.name = "VersionError";
  return err;
}

function writeConflictError() {
  const err = new Error("Write conflict during plan execution and yielding is disabled.");
  err.code = 112;
  err.codeName = "WriteConflict";
  return err;
}

function mockConversationModel() {
  const conversationPath = require.resolve("../src/models/conversationChat");
  require.cache[conversationPath] = {
    id: conversationPath,
    filename: conversationPath,
    loaded: true,
    exports: {
      findOne: async (filter) => {
        if (String(filter._id) !== String(convId)) return null;
        const allowed = new Set([String(senderId), String(recipientId)]);
        if (filter.participants) {
          const pid = String(filter.participants._id || filter.participants);
          if (!allowed.has(pid)) return null;
        }
        return {
          _id: convId,
          participants: [senderId, recipientId],
          unreadCount: new Map([[String(recipientId), 0], [String(senderId), 0]]),
        };
      },
      updateOne: async (filter, update) => {
        updateOneCalls += 1;
        if (simulatedUpdateOneFailures > 0) {
          simulatedUpdateOneFailures -= 1;
          throw versionError();
        }
        if (String(filter._id) !== String(convId)) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        return { matchedCount: 1, modifiedCount: 1, update };
      },
    },
  };
}

function mockMessageModel() {
  const messagePath = require.resolve("../src/models/message");
  require.cache[messagePath] = {
    id: messagePath,
    filename: messagePath,
    loaded: true,
    exports: {
      create: async (data) => {
        messageCreateCalls += 1;
        const doc = { _id: messageId, ...data, createdAt: new Date() };
        createdMessages.push(doc);
        return doc;
      },
      findByIdAndDelete: async (id) => {
        messageDeleteCalls += 1;
        createdMessages = createdMessages.filter((m) => String(m._id) !== String(id));
        return { _id: id };
      },
      findById: (id) => ({
        populate: async () => ({
          _id: id,
          text: "hello",
          sender: { _id: senderId, name: "Sender" },
        }),
      }),
      find: () => ({
        populate: () => ({
          sort: () => ({
            skip: () => ({
              limit: () => ({
                lean: async () => createdMessages.map((m) => ({
                  ...m,
                  sender: { _id: senderId, name: "Sender" },
                })),
              }),
            }),
          }),
        }),
      }),
      updateMany: async () => {
        updateManyCalls += 1;
        return { modifiedCount: 0 };
      },
    },
  };
}

function mockDeps() {
  mockConversationModel();
  mockMessageModel();

  const cachePath = require.resolve("../src/utils/responseCache.util");
  require.cache[cachePath] = {
    id: cachePath,
    filename: cachePath,
    loaded: true,
    exports: { invalidate: () => {} },
  };

  const chatNotifyPath = require.resolve("../src/services/chatNotification.service");
  require.cache[chatNotifyPath] = {
    id: chatNotifyPath,
    filename: chatNotifyPath,
    loaded: true,
    exports: { notifyChatMessage: async () => null },
  };

  const imagePath = require.resolve("../src/utils/imageProcess.util");
  require.cache[imagePath] = {
    id: imagePath,
    filename: imagePath,
    loaded: true,
    exports: { processDataUrlImage: async (v) => v },
  };

  const logPath = require.resolve("../src/utils/logSanitize.util");
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: { safeLog: () => {} },
  };
}

function loadController() {
  const controllerPath = require.resolve("../src/controllers/chat.controller");
  delete require.cache[controllerPath];
  return require("../src/controllers/chat.controller");
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function resetState() {
  updateOneCalls = 0;
  messageCreateCalls = 0;
  messageDeleteCalls = 0;
  updateManyCalls = 0;
  simulatedUpdateOneFailures = 0;
  createdMessages = [];
}

test("A. single message POST returns 201", async () => {
  resetState();
  mockDeps();
  const { sendMessage } = loadController();
  const req = {
    user: { id: senderId, name: "Sender" },
    body: { text: "hello" },
    params: { convId: String(convId) },
  };
  const res = mockRes();

  await sendMessage(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(messageCreateCalls, 1);
  assert.equal(updateOneCalls, 1);
  assert.equal(messageDeleteCalls, 0);
  assert.ok(res.body?.message);
});

test("B. ten sequential messages all succeed", async () => {
  resetState();
  mockDeps();
  const { sendMessage } = loadController();

  for (let i = 0; i < 10; i += 1) {
    const req = {
      user: { id: senderId, name: "Sender" },
      body: { text: `msg-${i}` },
      params: { convId: String(convId) },
    };
    const res = mockRes();
    await sendMessage(req, res);
    assert.equal(res.statusCode, 201, `message ${i} failed`);
  }

  assert.equal(messageCreateCalls, 10);
  assert.equal(updateOneCalls, 10);
  assert.equal(messageDeleteCalls, 0);
});

test("C. concurrent send + getMessages unread reset uses atomic updateOne (no save)", async () => {
  resetState();
  mockDeps();
  const { sendMessage, getMessages } = loadController();

  const sendReq = {
    user: { id: senderId, name: "Sender" },
    body: { text: "during poll" },
    params: { convId: String(convId) },
  };
  const getReq = {
    user: { id: recipientId },
    params: { convId: String(convId) },
    query: {},
  };
  const sendRes = mockRes();
  const getRes = mockRes();

  await Promise.all([
    sendMessage(sendReq, sendRes),
    getMessages(getReq, getRes),
  ]);

  assert.equal(sendRes.statusCode, 201);
  assert.equal(getRes.statusCode, 200);
  assert.equal(updateOneCalls, 2);
  assert.equal(messageDeleteCalls, 0);
});

test("D. two concurrent sends close together do not return 500", async () => {
  resetState();
  mockDeps();
  const { sendMessage } = loadController();

  const reqs = [0, 1].map((i) => ({
    user: { id: senderId, name: "Sender" },
    body: { text: `burst-${i}` },
    params: { convId: String(convId) },
  }));

  const results = await Promise.all(reqs.map(async (req) => {
    const res = mockRes();
    await sendMessage(req, res);
    return res;
  }));

  results.forEach((res, i) => {
    assert.equal(res.statusCode, 201, `burst send ${i} failed with ${res.statusCode}`);
  });
  assert.equal(messageCreateCalls, 2);
});

test("E. failed conversation update rolls back created message", async () => {
  resetState();
  simulatedUpdateOneFailures = 99;
  mockDeps();
  const { sendMessage } = loadController();

  const req = {
    user: { id: senderId, name: "Sender" },
    body: { text: "rollback me" },
    params: { convId: String(convId) },
  };
  const res = mockRes();

  await sendMessage(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(messageCreateCalls, 1);
  assert.equal(messageDeleteCalls, 1);
  assert.equal(createdMessages.length, 0);
  assert.equal(res.body.message, "تعذّر إرسال الرسالة");
});

test("F. transient VersionError on conversation update retries and succeeds", async () => {
  resetState();
  simulatedUpdateOneFailures = 2;
  mockDeps();
  const { sendMessage } = loadController();

  const req = {
    user: { id: senderId, name: "Sender" },
    body: { text: "retry ok" },
    params: { convId: String(convId) },
  };
  const res = mockRes();

  await sendMessage(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(messageCreateCalls, 1);
  assert.equal(updateOneCalls, 3);
  assert.equal(messageDeleteCalls, 0);
});

test("G. retry does not create duplicate messages", async () => {
  resetState();
  simulatedUpdateOneFailures = 1;
  mockDeps();
  const { sendMessage } = loadController();

  const req = {
    user: { id: senderId, name: "Sender" },
    body: { text: "one message only" },
    params: { convId: String(convId) },
  };
  const res = mockRes();

  await sendMessage(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(messageCreateCalls, 1);
  assert.equal(createdMessages.length, 1);
});

test("helper: buildSendConversationUpdate increments unread for recipients only", () => {
  mockDeps();
  const { _chatConcurrencyInternals } = loadController();
  const { buildSendConversationUpdate } = _chatConcurrencyInternals;

  const update = buildSendConversationUpdate([senderId, recipientId], senderId, messageId);

  assert.deepEqual(update.$set.lastMessage, messageId);
  assert.ok(update.$set.updatedAt instanceof Date);
  assert.equal(update.$inc[`unreadCount.${recipientId}`], 1);
  assert.equal(update.$inc[`unreadCount.${senderId}`], undefined);
});

test("helper: withConcurrencyRetry retries WriteConflict then succeeds", async () => {
  mockDeps();
  const { _chatConcurrencyInternals } = loadController();
  const { withConcurrencyRetry, isTransientConcurrencyError } = _chatConcurrencyInternals;

  assert.equal(isTransientConcurrencyError(versionError()), true);
  assert.equal(isTransientConcurrencyError(writeConflictError()), true);
  assert.equal(isTransientConcurrencyError({ status: 400 }), false);

  let attempts = 0;
  const result = await withConcurrencyRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw writeConflictError();
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("H. chat send rate limiter configuration unchanged", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/chat.routes.js"),
    "utf8",
  );

  assert.match(source, /max:\s*30/);
  assert.match(source, /windowMs:\s*60\s*\*\s*1000/);
  assert.match(source, /chatSendLimiter/);
  assert.match(source, /رسائل كثيرة — يرجى التمهل قليلاً/);
});
