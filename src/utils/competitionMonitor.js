const Competition = require("../models/competition");

const User = require("../models/user");

const notificationService = require("../services/notification.service");

const { safeLog } = require("./logSanitize.util");



function isCompetitionEnded(comp) {

  if (!comp) return false;

  if (comp.status === "ended") return true;

  if (comp.endDate && new Date(comp.endDate) <= new Date()) return true;

  return false;

}



function computeDisplayStatus(comp) {

  if (comp.status === "draft") return "draft";

  if (isCompetitionEnded(comp)) return "ended";

  return "active";

}



const NOTIFY_CHUNK = 400;



async function notifyUsersAboutDraw(comp) {

  const cursor = User.find({ status: "active" }).select("_id").lean().cursor({ batchSize: NOTIFY_CHUNK });

  let batch = [];

  let notifiedUsers = 0;



  for await (const user of cursor) {

    batch.push({

      user: user._id,

      type: "competition_draw",

      title: "موعد السحب اليوم!",

      body: `اليوم موعد السحب على مسابقة (${comp.title})، اضغط هنا لمشاهدة السحب.`,

      data: {

        competitionId: comp._id,

        drawLink: comp.drawLink || "",

        url: comp.drawLink || "",

      },

    });



    if (batch.length >= NOTIFY_CHUNK) {

      await notificationService.createMany(batch);

      notifiedUsers += batch.length;

      batch = [];

    }

  }



  if (batch.length) {

    await notificationService.createMany(batch);

    notifiedUsers += batch.length;

  }



  return notifiedUsers;

}



const monitorCompetitions = async () => {

  try {

    const now = new Date();

    const due = await Competition.find({

      endDate: { $lte: now },

      drawNotificationSent: false,

      status: { $ne: "draft" },

    }).select("title drawLink status endDate drawNotificationSent");



    if (!due.length) return;



    for (const comp of due) {

      comp.status = "ended";

      comp.drawNotificationSent = true;

      await comp.save();



      const notifiedUsers = await notifyUsersAboutDraw(comp);

      safeLog("info", "competition_monitor_ended", { competitionId: comp._id, notifiedUsers });

    }

  } catch (err) {

    safeLog("error", "competition_monitor_failed", { message: err.message });

  }

};



module.exports = monitorCompetitions;

