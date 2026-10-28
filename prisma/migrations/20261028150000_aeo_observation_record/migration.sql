ALTER TYPE "AIVisibilitySourceKind" ADD VALUE 'provider_api';

ALTER TABLE "AIVisibilityObservation"
  ADD COLUMN "answerText" VARCHAR(12000),
  ADD COLUMN "promptText" VARCHAR(4000),
  ADD COLUMN "locale" VARCHAR(35),
  ADD COLUMN "country" VARCHAR(2),
  ADD COLUMN "device" VARCHAR(32),
  ADD COLUMN "aiAnswerPresent" BOOLEAN,
  ADD COLUMN "modelVersion" VARCHAR(128),
  ADD COLUMN "runId" VARCHAR(128),
  ADD COLUMN "citedSources" JSONB,
  ADD COLUMN "mentionedBrands" JSONB;
