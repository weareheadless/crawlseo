import { describe, expect, it } from "vitest";
import { boundedQueryPlan } from "@/lib/research/runner";

describe("bounded audience research query plan", () => {
  it("creates bounded topic and question intents with observable provenance", () => {
    expect(boundedQueryPlan({ topics: ["solar panels"], questions: ["How do solar panels work?"], exclusions: [], limit: 5 }))
      .toEqual([
        { query: "solar panels", basis: "configured_topic" },
        { query: "solar panels problems", basis: "topic_intent" },
        { query: "How do solar panels work?", basis: "audience_question" },
        { query: "do solar panels work?", basis: "question_topic" },
      ]);
  });

  it("deduplicates normalized queries, excludes terms at word boundaries, and enforces the cap", () => {
    expect(boundedQueryPlan({ topics: ["Solar"], questions: ["solar", "How to finance"], exclusions: ["solar"], limit: 2 }))
      .toEqual([{ query: "How to finance", basis: "audience_question" }, { query: "to finance", basis: "question_topic" }]);
    expect(boundedQueryPlan({ topics: ["medical"], questions: [], exclusions: ["med"], limit: 5 }))
      .toEqual([{ query: "medical", basis: "configured_topic" }, { query: "medical problems", basis: "topic_intent" }]);
  });
});
