"""Synthetic provider failures: safe diagnostics, unchanged rejection."""

import json
from copy import deepcopy

import httpx
import pytest

from comparison import (
    MAX_OUTPUT_TOKENS,
    InvalidProviderOutput,
    ProviderSettings,
    compare,
)

CV = "SYNTHETIC_PRIVATE_CV: Prepared monthly reports."
JOB = "SYNTHETIC_PRIVATE_JOB: Monthly reporting required."
PRIVATE = "SYNTHETIC_PRIVATE_PROVIDER_CONTENT"
KEY = "SYNTHETIC_PRIVATE_API_KEY"
RESULT = {
    "inventory_complete": True,
    "requirements": [{
        "id": "req_0001", "requirement": "Monthly reporting",
        "job_evidence_id": "job_0001",
    }],
    "assessments": [{
        "requirement_id": "req_0001", "status": "matched",
        "cv_evidence_id": "cv_0001",
    }],
}


def envelope(result: object) -> dict:
    return {
        "status": "completed",
        "usage": {"output_tokens": 321},
        "output": [{
            "type": "message",
            "content": [{"type": "output_text", "text": json.dumps(result)}],
        }],
    }


def reject_and_capture(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    body: object,
    *, raw: bool = False,
) -> dict:
    calls = []

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        calls.append(1)
        payload = {"content": body} if raw else {"json": body}
        return httpx.Response(
            200, request=httpx.Request("POST", "https://example.test"),
            **payload,
        )

    monkeypatch.setattr("comparison._post_once", fake_post)
    with pytest.raises(InvalidProviderOutput) as caught:
        compare(CV, JOB, ProviderSettings(KEY, "gpt-4o-mini"))
    assert str(caught.value) == ""
    assert len(calls) == 1
    records = [r for r in caplog.records if r.name == "comparison"]
    assert len(records) == 1
    assert records[0].exc_info is None
    assert records[0].stack_info is None
    for private in (CV, JOB, PRIVATE, KEY):
        assert private not in caplog.text
    prefix, payload = records[0].getMessage().split(" ", 1)
    assert prefix == "comparison_invalid_output"
    diagnostic = json.loads(payload)
    assert diagnostic["max_output_tokens"] == MAX_OUTPUT_TOKENS
    assert diagnostic["cv_chars"] == len(CV)
    assert diagnostic["job_chars"] == len(JOB)
    return diagnostic


@pytest.mark.parametrize(
    "status,reason,category",
    [
        ("incomplete", "max_output_tokens", "incomplete_output"),
        ("incomplete", "content_filter", "incomplete_output"),
        ("failed", None, "provider_not_completed"),
        ("cancelled", None, "provider_not_completed"),
        (None, None, "provider_not_completed"),
    ],
)
def test_completion_diagnostics(
    monkeypatch, caplog, status, reason, category,
) -> None:
    body = envelope(RESULT)
    body.update({
        "status": status,
        "incomplete_details": {"reason": reason},
        "usage": {"output_tokens": 1200},
    })
    diagnostic = reject_and_capture(monkeypatch, caplog, body)
    assert diagnostic["category"] == category
    assert diagnostic["field"] == "response.status"
    assert diagnostic["provider_status"] == (status or "missing")
    assert diagnostic["incomplete_reason"] == (reason or "missing")
    assert diagnostic["finish_reason"] == "missing"
    assert diagnostic["output_tokens"] == 1200


def test_unknown_metadata_values_are_not_logged(monkeypatch, caplog) -> None:
    body = envelope(RESULT)
    body.update({
        "status": PRIVATE, "finish_reason": PRIVATE,
        "incomplete_details": {"reason": PRIVATE},
        "usage": {"output_tokens": PRIVATE},
        "error": {"message": PRIVATE},
    })
    diagnostic = reject_and_capture(monkeypatch, caplog, body)
    assert diagnostic["provider_status"] == "other"
    assert diagnostic["finish_reason"] == "other"
    assert diagnostic["incomplete_reason"] == "other"
    assert diagnostic["output_tokens"] is None


@pytest.mark.parametrize("outer_json", [True, False])
def test_invalid_json_distinguishes_envelope_and_generated_text(
    monkeypatch, caplog, outer_json,
) -> None:
    body = PRIVATE.encode() if outer_json else envelope(RESULT)
    if not outer_json:
        body["output"][0]["content"][0]["text"] = PRIVATE
    diagnostic = reject_and_capture(
        monkeypatch, caplog, body, raw=outer_json,
    )
    assert diagnostic["category"] == "invalid_json"
    if outer_json:
        assert diagnostic["field"] == "response"
        assert diagnostic["provider_status"] == "missing"
        assert diagnostic["response_bytes"] == len(PRIVATE)
    else:
        assert diagnostic["field"] == "response.output[0].content[0].text"
        assert diagnostic["provider_status"] == "completed"
        assert diagnostic["output_text_chars"] == len(PRIVATE)
        assert diagnostic["json_error_position"] == 0


@pytest.mark.parametrize(
    "body,category,field",
    [
        ([], "response_envelope", "response"),
        ({"status": "completed"}, "response_envelope", "response.output"),
        (
            {"status": "completed", "output": [None]},
            "response_envelope", "response.output[0]",
        ),
        (
            {"status": "completed", "output": [{"type": "message"}]},
            "response_envelope", "response.output[0].content",
        ),
        (
            {"status": "completed", "output": []},
            "output_text_count", "response.output",
        ),
        (
            {"status": "completed", "output": envelope(RESULT)["output"] * 2},
            "output_text_count", "response.output",
        ),
        (
            {"status": "completed", "output": [{
                "type": "message", "content": [{
                    "type": "refusal", "refusal": PRIVATE,
                }],
            }]},
            "refusal", "response.output",
        ),
        (
            {"status": "completed", "output": [{
                "type": "message", "content": [None],
            }]},
            "response_envelope", "response.output[0].content[0]",
        ),
        (
            {"status": "completed", "output": [{
                "type": "message", "content": [{"type": "output_text"}],
            }]},
            "response_envelope", "response.output[0].content[0].text",
        ),
        (envelope([]), "schema_validation", "$"),
        (envelope({}), "schema_validation", "$.assessments"),
        (
            envelope({**RESULT, PRIVATE: PRIVATE}),
            "schema_validation", "$.<extra>",
        ),
    ],
)
def test_other_rejections_have_safe_categories_and_paths(
    monkeypatch, caplog, body, category, field,
) -> None:
    diagnostic = reject_and_capture(monkeypatch, caplog, body)
    assert diagnostic["category"] == category
    assert diagnostic["field"] == field


@pytest.mark.parametrize(
    "group,field,value,category,length",
    [
        ("requirements", "requirement", "x" * 161,
         "length_constraint", 161),
        ("assessments", "cv_evidence_id", "x" * 25,
         "length_constraint", 25),
        ("requirements", "job_evidence_id", "x" * 25,
         "length_constraint", 25),
        ("assessments", "requirement_id", "",
         "length_constraint", 0),
        ("requirements", "requirement", "  ", "blank_field", 2),
        ("requirements", "requirement", 7, "schema_validation", None),
        ("requirements", PRIVATE, PRIVATE,
         "schema_validation", len(PRIVATE)),
    ],
)
def test_field_validation_logs_lengths_not_input_values(
    monkeypatch, caplog, group, field, value, category, length,
) -> None:
    result = deepcopy(RESULT)
    result[group][0][field] = value
    diagnostic = reject_and_capture(monkeypatch, caplog, envelope(result))
    assert diagnostic["category"] == category
    safe_field = "<extra>" if field == PRIVATE else field
    assert diagnostic["field"] == f"$.{group}[0].{safe_field}"
    assert diagnostic.get("actual_length") == length
    assert diagnostic["validation_error_count"] == 1
    assert diagnostic["provider_status"] == "completed"
    assert diagnostic["output_tokens"] == 321


@pytest.mark.parametrize("field", ["requirements", "assessments"])
def test_list_limit_remains_strict(monkeypatch, caplog, field) -> None:
    result = deepcopy(RESULT)
    result[field] = result[field] * 21
    diagnostic = reject_and_capture(monkeypatch, caplog, envelope(result))
    assert diagnostic["category"] == "length_constraint"
    assert diagnostic["field"] == f"$.{field}"
    assert diagnostic["actual_length"] == 21
    assert diagnostic[field + "_count"] == 21
    assert diagnostic["validation_type"] == "too_long"


@pytest.mark.parametrize(
    "group,field",
    [
        ("assessments", "cv_evidence_id"),
        ("requirements", "job_evidence_id"),
    ],
)
def test_unknown_reference_keeps_validation_strict_and_ids_private(
    monkeypatch, caplog, group, field,
) -> None:
    result = deepcopy(RESULT)
    result[group][0][field] = "missing_0001"
    diagnostic = reject_and_capture(monkeypatch, caplog, envelope(result))
    assert diagnostic["category"] == "unknown_evidence_id"
    assert diagnostic["field"] == f"$.{group}[0].{field}"
    assert diagnostic["provider_status"] == "completed"
    assert diagnostic["output_tokens"] == 321


@pytest.mark.parametrize(
    "group,field,wrong_id",
    [
        ("assessments", "cv_evidence_id", "job_0001"),
        ("requirements", "job_evidence_id", "cv_0001"),
    ],
)
def test_wrong_source_reference_is_rejected_without_leaking_text(
    monkeypatch, caplog, group, field, wrong_id,
) -> None:
    result = deepcopy(RESULT)
    result[group][0][field] = wrong_id
    diagnostic = reject_and_capture(monkeypatch, caplog, envelope(result))

    assert diagnostic["category"] == "wrong_source_reference"
    assert diagnostic["field"] == f"$.{group}[0].{field}"
    assert wrong_id not in caplog.text


def test_success_has_no_failure_diagnostics(monkeypatch, caplog) -> None:
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *args, **kwargs: httpx.Response(
            200, json=envelope(RESULT),
            request=httpx.Request("POST", "https://example.test"),
        ),
    )
    result = compare(CV, JOB, ProviderSettings(KEY, "gpt-4o-mini"))
    assert result.matched_requirements[0].cv_evidence == CV
    assert not [r for r in caplog.records if r.name == "comparison"]
