-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SuperAdmin', 'Viewer', 'Support');

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'Viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admins_api_key_key" ON "admins"("api_key");

-- CreateIndex
CREATE INDEX "admins_api_key_idx" ON "admins"("api_key");

-- CreateIndex
CREATE INDEX "admins_role_idx" ON "admins"("role");
