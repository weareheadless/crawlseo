-- The O13/O14 detectors accept gap-typed findings, but the enum could not produce
-- them: CONCERN/OBJECTION/MISCONCEPTION/QUESTION/CONTENT_GAP are mapped to O13 in
-- code, and these two values give O14 a type the research runner can emit.
ALTER TYPE "ResearchFindingType" ADD VALUE 'POSITIONING_GAP';
ALTER TYPE "ResearchFindingType" ADD VALUE 'COMPETITOR_GAP';
