// Mock core-banking: opens an account and puts the customer on the bank's books (ExistingCustomer).
const crypto = require("crypto");

async function createAccount({ id, panNumber, fullName, dob, rekycDueDate }) {
  const { prisma } = require("./core");
  const prior = await prisma.existingCustomer.findUnique({
    where: { applicationId: id },
  });
  if (prior)
    return { customerId: prior.customerId, accountNumber: prior.accountNumber }; // idempotent per application
  const customerId = "DD" + crypto.randomInt(1e7, 1e8);
  const accountNumber = "5010" + crypto.randomInt(1e9, 1e10);
  await prisma.existingCustomer.create({
    data: {
      customerId,
      accountNumber,
      fullName,
      panNumber,
      dob: dob || "",
      rekycDueDate,
      applicationId: id,
    },
  });
  return { customerId, accountNumber };
}

module.exports = { createAccount };
