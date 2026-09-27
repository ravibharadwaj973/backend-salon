-- A gallery photograph can name the service it is work for, so the website can
-- show the price beside the picture and offer to book it. Nullable: the studio
-- photographs are not work for anything. No foreign key on purpose — a deleted
-- service must not cascade away the photographs of work that was really done;
-- the public gallery simply stops showing a price for them.
ALTER TABLE "gallery_photos" ADD COLUMN "serviceId" TEXT;
CREATE INDEX "gallery_photos_serviceId_idx" ON "gallery_photos"("serviceId");
