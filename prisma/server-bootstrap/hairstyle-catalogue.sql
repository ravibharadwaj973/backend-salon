-- =============================================================================
-- THE HAIRSTYLE CATALOGUE, FOR EVERY SALON ON THIS SERVER.
--
-- Run this AFTER the schema exists and AFTER at least one salon has been
-- created, because a catalogue row belongs to a tenant.
--
-- Safe to run as often as you like: the (tenantId, kind, name) unique key makes
-- a second run a no-op, and a style a salon has renamed keeps its name.
--
-- The app can do the same job from the Hairstyles screen -- "Add the standard
-- menu" -- which is easier if you have one salon. This file is for doing it to
-- all of them at once.
--
-- Generated from src/modules/hair-studio/hairstyle-kinds.ts, which is the list
-- of cuts the 3D studio can actually draw. Do not invent a `kind` here: one the
-- studio has no generator for renders a bald head and reports nothing.
-- =============================================================================

INSERT INTO "hairstyle_catalog" (
  "id", "tenantId", "kind", "name", "category", "gender",
  "supportedTextures", "supportedLengths", "supportedDensities", "recommendedFaceShapes",
  "supportsBangs", "supportsLayers", "supportsParting", "supportsFade",
  "maintenance", "serviceId", "isActive", "sortOrder", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  t."id",
  v.kind, v.name, v.category, v.gender::"Gender",
  v.textures, v.lengths, v.densities, v.faces,
  v.bangs, v.layers, v.parting, v.fade,
  v.maintenance::"HairMaintenance",
  -- Linked to the salon's own haircut service where it has one. NULL is a fine
  -- answer: the style shows as "Not bookable" until somebody attaches a
  -- service, which is true rather than a guess at their price list.
  (
    SELECT s."id" FROM "services" s
    WHERE s."tenantId" = t."id"
      AND s."isActive"
      AND s."name" = CASE WHEN v.gender = 'MALE' THEN 'Haircut (Men)' ELSE 'Haircut (Women)' END
    LIMIT 1
  ),
  true, v.sort, now(), now()
FROM "tenants" t
CROSS JOIN (VALUES
  ('bob', 'Bob', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'MEDIUM', 1),
  ('bob', 'Chin-length bob', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'MEDIUM', 2),
  ('bob', 'A-line bob', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'MEDIUM', 3),
  ('lob', 'Lob', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','HEART']::"FaceShape"[], true, true, true, false, 'LOW', 4),
  ('pixie', 'Pixie', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','HEART','DIAMOND']::"FaceShape"[], true, true, true, true, 'HIGH', 5),
  ('pixie', 'Long pixie', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','HEART','DIAMOND']::"FaceShape"[], true, true, true, true, 'HIGH', 6),
  ('butterfly_cut', 'Butterfly cut', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['MEDIUM','LONG','VERY_LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'MEDIUM', 7),
  ('layered_cut', 'Layered cut', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['MEDIUM','LONG','VERY_LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'LOW', 8),
  ('layered_cut', 'Long layers', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['MEDIUM','LONG','VERY_LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'LOW', 9),
  ('layered_cut', 'Short layers', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['MEDIUM','LONG','VERY_LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'LOW', 10),
  ('wolf_cut', 'Wolf cut', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['MEDIUM','LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','HEART']::"FaceShape"[], true, true, true, false, 'MEDIUM', 11),
  ('shag', 'Shag', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['SHORT','MEDIUM','LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','SQUARE','OBLONG']::"FaceShape"[], true, true, true, false, 'MEDIUM', 12),
  ('blunt_cut', 'Blunt cut', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY']::"HairTexture"[], ARRAY['SHORT','MEDIUM','LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','HEART']::"FaceShape"[], true, false, true, false, 'MEDIUM', 13),
  ('long_loose', 'Straight long hair', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['LONG','VERY_LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'LOW', 14),
  ('long_loose', 'Wavy long hair', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['LONG','VERY_LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'LOW', 15),
  ('long_loose', 'Curly long hair', 'Women''s haircut', 'FEMALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['LONG','VERY_LONG']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], true, true, true, false, 'LOW', 16),
  ('fade', 'Low fade', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], false, false, true, true, 'HIGH', 17),
  ('fade', 'Mid fade', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], false, false, true, true, 'HIGH', 18),
  ('fade', 'High fade', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], false, false, true, true, 'HIGH', 19),
  ('fade', 'Skin fade', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], false, false, true, true, 'HIGH', 20),
  ('taper', 'Taper', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], false, false, true, true, 'MEDIUM', 21),
  ('taper', 'Taper fade', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE','OBLONG','HEART','DIAMOND']::"FaceShape"[], false, false, true, true, 'MEDIUM', 22),
  ('buzz_cut', 'Buzz cut', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','SQUARE','DIAMOND']::"FaceShape"[], false, false, false, true, 'LOW', 23),
  ('crew_cut', 'Crew cut', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['VERY_SHORT','SHORT']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','SQUARE','OBLONG']::"FaceShape"[], false, false, true, true, 'MEDIUM', 24),
  ('crop', 'Textured crop', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','OBLONG','DIAMOND']::"FaceShape"[], true, true, true, true, 'MEDIUM', 25),
  ('crop', 'French crop', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','OBLONG','DIAMOND']::"FaceShape"[], true, true, true, true, 'MEDIUM', 26),
  ('quiff', 'Quiff', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE']::"FaceShape"[], false, true, true, true, 'HIGH', 27),
  ('pompadour', 'Pompadour', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','SQUARE']::"FaceShape"[], false, true, true, true, 'HIGH', 28),
  ('slick_back', 'Slick back', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','SQUARE','DIAMOND']::"FaceShape"[], false, false, false, true, 'MEDIUM', 29),
  ('undercut', 'Undercut', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','HEART']::"FaceShape"[], false, true, true, true, 'HIGH', 30),
  ('undercut', 'Disconnected undercut', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY','CURLY','COILY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','HEART']::"FaceShape"[], false, true, true, true, 'HIGH', 31),
  ('side_part', 'Side part', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','OBLONG','HEART']::"FaceShape"[], false, true, true, true, 'MEDIUM', 32),
  ('side_part', 'Messy side part', 'Men''s haircut', 'MALE', ARRAY['STRAIGHT','WAVY']::"HairTexture"[], ARRAY['SHORT','MEDIUM']::"HairLength"[], ARRAY['LOW','MEDIUM','HIGH']::"HairDensity"[], ARRAY['OVAL','ROUND','OBLONG','HEART']::"FaceShape"[], false, true, true, true, 'MEDIUM', 33)
) AS v(kind, name, category, gender, textures, lengths, densities, faces, bangs, layers, parting, fade, maintenance, sort)
ON CONFLICT ("tenantId", "kind", "name") DO NOTHING;

-- What landed, per salon.
SELECT t."name" AS salon, count(h.*) AS hairstyles, count(h."serviceId") AS bookable
FROM "tenants" t
LEFT JOIN "hairstyle_catalog" h ON h."tenantId" = t."id"
GROUP BY t."name"
ORDER BY t."name";
