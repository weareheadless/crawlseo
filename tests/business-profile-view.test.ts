import { describe, expect, it } from "vitest";
import { confirmationStatus, profileValue } from "@/lib/projects/business-profile-view";

describe("business profile rendering helpers", () => {
  it("marks absent profile facts as not recorded", () => expect(profileValue(null)).toBe("Not recorded"));
  it("preserves an unaccepted revision status", () => expect(confirmationStatus("advised")).toBe("unconfirmed"));
  it("recognizes accepted owner facts", () => expect(confirmationStatus("owner_confirmed")).toBe("confirmed"));
});
