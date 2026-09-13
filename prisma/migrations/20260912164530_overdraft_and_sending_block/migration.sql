/*
  Warnings:

  - You are about to drop the column `monthlyMessages` on the `plans` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "MeterKey" AS ENUM ('WA_UTILITY', 'WA_MARKETING', 'WA_AUTHENTICATION', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "CreditEntryReason" AS ENUM ('PURCHASE', 'CONSUMPTION', 'ADJUSTMENT', 'EXPIRY');

-- CreateEnum
CREATE TYPE "MessagingSetupStatus" AS ENUM ('NOT_CONNECTED', 'PENDING', 'CONNECTED', 'FAILED');

-- AlterTable
ALTER TABLE "message_logs" ADD COLUMN     "category" "TemplateCategory" NOT NULL DEFAULT 'UTILITY',
ADD COLUMN     "meter" "MeterKey";

-- AlterTable
ALTER TABLE "message_templates" ADD COLUMN     "libraryKey" TEXT;

-- AlterTable
ALTER TABLE "plans" DROP COLUMN "monthlyMessages",
ADD COLUMN     "emailQuota" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "extraBranchPrice" DECIMAL(12,2),
ADD COLUMN     "maxCampaignsPerMonth" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "overdraftLimit" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "smsQuota" INTEGER NOT NULL DEFAULT 250,
ADD COLUMN     "waAuthQuota" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "waMarketingQuota" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "waUtilityQuota" INTEGER NOT NULL DEFAULT 500;

-- CreateTable
CREATE TABLE "tenant_messaging_config" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "waStatus" "MessagingSetupStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "waPhoneNumberId" TEXT,
    "waBusinessId" TEXT,
    "waAccessToken" TEXT,
    "waDisplayNumber" TEXT,
    "waVerifiedAt" TIMESTAMP(3),
    "smsStatus" "MessagingSetupStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "smsSenderId" TEXT,
    "smsApiKey" TEXT,
    "smsDltEntityId" TEXT,
    "smsRoute" TEXT,
    "emailStatus" "MessagingSetupStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "emailFromName" TEXT,
    "emailFromAddress" TEXT,
    "emailApiKey" TEXT,
    "emailReplyTo" TEXT,
    "sendingBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "owedMessages" INTEGER NOT NULL DEFAULT 0,
    "unblockedAt" TIMESTAMP(3),
    "unblockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_messaging_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_packs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "meter" "MeterKey" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "planId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_usage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meter" "MeterKey" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "included" INTEGER NOT NULL DEFAULT 0,
    "used" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_balances" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meter" "MeterKey" NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meter" "MeterKey" NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" "CreditEntryReason" NOT NULL,
    "packId" TEXT,
    "messageLogId" TEXT,
    "amountPaid" DECIMAL(12,2),
    "paymentMode" "PaymentMode",
    "reference" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_messaging_config_tenantId_key" ON "tenant_messaging_config"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_packs_code_key" ON "credit_packs"("code");

-- CreateIndex
CREATE INDEX "credit_packs_meter_isActive_idx" ON "credit_packs"("meter", "isActive");

-- CreateIndex
CREATE INDEX "message_usage_tenantId_periodStart_idx" ON "message_usage"("tenantId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "message_usage_tenantId_meter_periodStart_key" ON "message_usage"("tenantId", "meter", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "credit_balances_tenantId_meter_key" ON "credit_balances"("tenantId", "meter");

-- CreateIndex
CREATE INDEX "credit_ledger_tenantId_meter_createdAt_idx" ON "credit_ledger"("tenantId", "meter", "createdAt");

-- AddForeignKey
ALTER TABLE "tenant_messaging_config" ADD CONSTRAINT "tenant_messaging_config_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_packs" ADD CONSTRAINT "credit_packs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_usage" ADD CONSTRAINT "message_usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_packId_fkey" FOREIGN KEY ("packId") REFERENCES "credit_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
