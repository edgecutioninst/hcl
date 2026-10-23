// Scheduled jobs: expire stale resubmissions; list customers due for re-KYC in the next 30 days.
const cron = require("node-cron");
const { prisma, audit } = require("./core");

async function expireResubmissions() {
  const stale = await prisma.application.findMany({
    where: {
      status: "RESUBMISSION_REQUESTED",
      resubmissionDue: { lt: new Date() },
    },
  });
  for (const a of stale) {
    const u = await prisma.application.updateMany({
      where: { id: a.id, version: a.version },
      data: {
        status: "CLOSED_EXPIRED",
        decidedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (u.count)
      await audit(null, {
        applicationId: a.id,
        action: "STATUS_CHANGE",
        entityType: "Application",
        entityId: a.id,
        before: { status: a.status },
        after: { status: "CLOSED_EXPIRED" },
      });
  }
  return stale.length;
}

async function rekycDue(days = 30) {
  const ist = (d) =>
    new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const now = new Date();
  return prisma.existingCustomer.findMany({
    where: {
      rekycDueDate: {
        gte: ist(now),
        lte: ist(new Date(now.getTime() + days * 86400e3)),
      },
    },
    select: {
      customerId: true,
      fullName: true,
      panNumber: true,
      rekycDueDate: true,
    },
    orderBy: { rekycDueDate: "asc" },
  });
}

function startCron() {
  cron.schedule(
    "0 * * * *",
    () =>
      expireResubmissions().then(
        (n) => n && console.log(`expired ${n} resubmissions`),
      ),
    { timezone: "Asia/Kolkata" },
  );
  cron.schedule(
    "0 6 * * *",
    async () => {
      const due = await rekycDue();
      console.log(`re-KYC due in next 30 days: ${due.length} customers`); // reminder = log entry (no real SMS/e-mail)
      await audit(null, {
        action: "REKYC_REMINDER_RUN",
        after: { count: due.length, customerIds: due.map((c) => c.customerId) },
      });
    },
    { timezone: "Asia/Kolkata" },
  );
}

module.exports = { startCron, expireResubmissions, rekycDue };
