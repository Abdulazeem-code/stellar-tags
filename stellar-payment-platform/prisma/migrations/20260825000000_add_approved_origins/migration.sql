-- CreateTable: approved_origins for dynamic CORS origin validation
CREATE TABLE "approved_origins" (
    "id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approved_origins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique constraint on origin
CREATE UNIQUE INDEX "approved_origins_origin_key" ON "approved_origins"("origin");
