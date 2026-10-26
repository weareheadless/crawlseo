#!/usr/bin/env python3
"""Small Python consumer compatibility check for the shared v1 fixtures."""

import json
from pathlib import Path

from jsonschema import Draft7Validator, FormatChecker


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "contracts/business-knowledge-v1.schema.json").read_text())
FIXTURES = json.loads((ROOT / "examples/business-knowledge-v1-fixtures.json").read_text())
VALIDATOR = Draft7Validator(SCHEMA, format_checker=FormatChecker())


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def valid_lifecycle(document):
    accepted_revision = document["acceptedRevision"]
    if accepted_revision is not None and accepted_revision > document["revision"]:
        return False
    return document["state"] != "accepted" or accepted_revision == document["revision"]


def resolve_conflict(case):
    """Apply scope, idempotency, then CAS checks in the documented order."""
    request = case["request"]
    credential = case["credential"]
    state = case["state"]
    if (request["workspaceId"], request["projectId"]) != (credential["workspaceId"], credential["projectId"]):
        return "NOT_FOUND"
    required_permission = "document:read" if request["kind"] == "document_read" else "document:write"
    if required_permission not in credential["permissions"]:
        return "FORBIDDEN"
    if case.get("priorRequest"):
        prior = case["priorRequest"]
        if prior["idempotencyKey"] == request["idempotencyKey"]:
            return "IDEMPOTENCY_CONFLICT" if prior != request else "REPLAY_PRIOR_RESULT"
    if request.get("expectedRevision") != state["revision"]:
        return "REVISION_CONFLICT"
    return "APPLY"


def main():
    for index, fixture in enumerate(FIXTURES["valid"]):
        require(not list(VALIDATOR.iter_errors(fixture)), f"valid fixture {index} rejected by schema")
        if fixture["kind"] == "business_document":
            require(valid_lifecycle(fixture), f"valid document {index} has an impossible acceptance pin")
        if fixture["kind"] == "project_registration":
            origin = fixture["origin"]
            require(origin["system"] + ":" + origin["externalId"] == fixture["externalProjectId"], "registration external ID must encode its origin tuple")
        if fixture["kind"] == "project_registration_result":
            require(fixture["projectId"] != fixture["externalProjectId"], "registration result must distinguish server and external IDs")

    for index, fixture in enumerate(FIXTURES["invalid"]):
        errors = list(VALIDATOR.iter_errors(fixture))
        lifecycle_invalid = fixture.get("kind") == "business_document" and not valid_lifecycle(fixture)
        registration_invalid = fixture.get("kind") == "project_registration" and "origin" in fixture and "externalProjectId" in fixture and fixture["origin"]["system"] + ":" + fixture["origin"]["externalId"] != fixture["externalProjectId"]
        require(errors or lifecycle_invalid or registration_invalid, f"invalid fixture {index} was accepted")

    expected = {
        "stale-revision": "REVISION_CONFLICT",
        "same-idempotency-key-different-body": "IDEMPOTENCY_CONFLICT",
        "wrong-project-scope": "NOT_FOUND",
    }
    for case in FIXTURES["conflictCases"]:
        require(not list(VALIDATOR.iter_errors(case["request"])), f"conflict request {case['name']} rejected by schema")
        require(not list(VALIDATOR.iter_errors(case["response"])), f"conflict response {case['name']} rejected by schema")
        require(resolve_conflict(case) == expected[case["name"]], f"wrong consumer outcome for {case['name']}")
        require(case["response"]["code"] == expected[case["name"]], f"fixture response disagrees for {case['name']}")

    for case in FIXTURES["acceptanceCases"]:
        require(not list(VALIDATOR.iter_errors(case["request"])), f"acceptance request {case['name']} rejected by schema")
        before, after = case["before"], case["after"]
        require(case["request"]["expectedRevision"] == before["revision"], "acceptance must compare the current revision")
        require(after == {"revision": before["revision"], "state": "accepted", "acceptedRevision": before["revision"]}, "acceptance must pin the current immutable revision")
        require(case["acceptedRead"]["revision"] == after["acceptedRevision"], "accepted read must return the pinned snapshot")

    for case in FIXTURES["historicalReadCases"]:
        require(not list(VALIDATOR.iter_errors(case["read"])), f"historical read {case['name']} rejected by schema")
        require(case["read"]["view"] == "accepted", "historical snapshot example must request accepted view")
        requested_revision = case["read"].get("revision")
        require(requested_revision in case["state"]["acceptedRevisions"], "an explicit accepted read must reference an acceptance event")
        require(requested_revision < case["state"]["acceptedRevision"], "historical read fixture must select an older accepted revision after pointer advance")
        require(case["result"]["revision"] == requested_revision, "explicit revision read must return that exact snapshot")

    print(f"Python consumer compatibility passed: {len(FIXTURES['valid'])} valid, {len(FIXTURES['invalid'])} invalid, {len(FIXTURES['conflictCases'])} conflicts, {len(FIXTURES['acceptanceCases']) + len(FIXTURES['historicalReadCases'])} lifecycle cases")


if __name__ == "__main__":
    main()
