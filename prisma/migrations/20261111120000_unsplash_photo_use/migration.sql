-- A cover photo is chosen once and never reused, across posts and across the
-- weekly generation that shares this pool.
CREATE TABLE "UnsplashPhotoUse" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "siteId" TEXT,
    "query" TEXT,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnsplashPhotoUse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnsplashPhotoUse_photoId_key" ON "UnsplashPhotoUse"("photoId");
CREATE INDEX "UnsplashPhotoUse_usedAt_idx" ON "UnsplashPhotoUse"("usedAt");
