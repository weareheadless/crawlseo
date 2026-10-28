import { describe, expect, it } from "vitest";
import { keywordRunRows } from "@/lib/dataforseo/keyword-run-view";
const base = { id:"r",seed:"seed",kind:"KEYWORD_OVERVIEW",requestedAt:new Date(0),completedAt:null,costMicros:null,errorCode:null };
describe("keyword run view", () => {
 it("does not present failed/missing results as zero keywords and sorts results by volume", () => {
 const [failed, missing, complete] = keywordRunRows([
 { ...base,status:"FAILED",result:[{keyword:"bad",volume:1}] },
 { ...base,status:"COMPLETED",result:null },
 { ...base,status:"COMPLETED",result:[{keyword:"low",volume:3,difficulty:null,cpc:null},{keyword:"high",volume:20,difficulty:null,cpc:null}] },
 ]);
 expect(failed.keywordCount).toBeNull(); expect(missing.keywordCount).toBeNull(); expect(complete.keywords.map((x) => x.keyword)).toEqual(["high","low"]);
 });
});
