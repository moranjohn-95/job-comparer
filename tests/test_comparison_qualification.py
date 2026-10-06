"""Synthetic credential-type checks; not a substitute for model judgment."""

import json

import httpx
import pytest

from comparison import (
    ProviderSettings,
    _credential_type_supported,
    compare,
)


@pytest.mark.parametrize(
    "requirement,evidence,supported",
    [
        (
            "Relevant degree in computing",
            "Distinction Diploma in Software Development",
            False,
        ),
        (
            "Nursing degree required",
            "Diploma in Nursing Practice",
            False,
        ),
        (
            "Food safety diploma required",
            "Food safety certificate completed",
            False,
        ),
        (
            "Master's degree in public health required",
            "Bachelor of Public Health",
            False,
        ),
        (
            "Relevant degree in computing",
            "BSc in Computing",
            True,
        ),
        (
            "Relevant degree OR diploma in catering",
            "Diploma in Catering",
            True,
        ),
        (
            "Experience preparing pastries",
            "Prepared pastries for community events",
            True,
        ),
    ],
)
def test_explicit_credential_type_is_a_necessary_match_condition(
    requirement: str,
    evidence: str,
    supported: bool,
) -> None:
    assert _credential_type_supported(requirement, evidence) is supported


@pytest.mark.parametrize(
    "cv,job,requirement",
    [
        (
            "Education: Diploma in Software Development.",
            "A degree in Computer Science or similar is required.",
            "Relevant degree in Computer Science or similar",
        ),
        (
            "Education: Diploma in Nursing Practice.",
            "A nursing degree is required.",
            "Required nursing degree",
        ),
    ],
)
def test_provider_match_with_wrong_credential_type_is_withheld(
    monkeypatch: pytest.MonkeyPatch,
    cv: str,
    job: str,
    requirement: str,
) -> None:
    output = {
        "inventory_complete": True,
        "requirements": [{
            "id": "req_0001", "requirement": requirement,
            "job_evidence_id": "job_0001",
        }],
        "assessments": [{
            "requirement_id": "req_0001", "status": "matched",
            "cv_evidence_id": "cv_0001", "reason": "",
        }],
    }
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: httpx.Response(
            200, request=httpx.Request("POST", "https://example.test"),
            json={
                "status": "completed",
                "output": [{
                    "type": "message", "content": [{
                        "type": "output_text", "text": json.dumps(output),
                    }],
                }],
            },
        ),
    )

    result = compare(cv, job, ProviderSettings("test-key", "gpt-4o-mini"))

    assert result.matched_requirements == []
    assert result.possible_gaps == []
    assert "comparison is incomplete" in result.interpretation
    assert len(result.needs_review) == 1
    review = result.needs_review[0]
    assert review.requirement == requirement
    assert review.cv_evidence == cv
    assert review.job_evidence == job
    assert "Other CV evidence has not been ruled out" in review.reason
    assert requirement not in result.interpretation
    assert "not a complete assessment" in result.interpretation
