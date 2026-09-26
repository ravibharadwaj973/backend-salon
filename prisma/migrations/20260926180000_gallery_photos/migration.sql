-- The salon's own record of each photograph. The file lives in Cloudinary;
-- publicId is the join. See the model comment in schema.prisma for why both.
CREATE TABLE "gallery_photos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "alt" TEXT NOT NULL,
    "caption" TEXT,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gallery_photos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gallery_photos_publicId_key" ON "gallery_photos"("publicId");
CREATE INDEX "gallery_photos_tenantId_collection_sortOrder_idx" ON "gallery_photos"("tenantId", "collection", "sortOrder");
