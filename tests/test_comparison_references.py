"""Synthetic source-ID, coverage, and legacy-offset regressions."""

import json

import httpx
import pytest

from comparison import (
    MAX_EVIDENCE_CHARS,
    ComparisonResult,
    InvalidProviderOutput,
    ProviderSettings,
    check_input_limits,
    compare,
    source_excerpts,
)


def mock_provider(monkeypatch: pytest.MonkeyPatch, result: dict) -> list:
    calls = []

    def fake_post(*_: object, **kwargs: object) -> httpx.Response:
        calls.append(kwargs["json"])
        return httpx.Response(
            200, request=httpx.Request("POST", "https://example.test"),
            json={
                "status": "completed",
                "output": [{
                    "type": "message", "content": [{
                        "type": "output_text", "text": json.dumps(result),
                    }],
                }],
            },
        )

    monkeypatch.setattr("comparison._post_once", fake_post)
    return calls


@pytest.mark.parametrize("size", [1, 239, 240, 241, 1200])
def test_excerpt_ids_cover_every_character_at_length_boundaries(
    size: int,
) -> None:
    text = ("Section one.\n\tNext section\u00a0with context. " * 40)[:size]
    excerpts = source_excerpts(text, "cv")

    assert excerpts == source_excerpts(text, "cv")
    assert "".join(item["text"] for item in excerpts) == text
    assert [item["id"] for item in excerpts] == [
        f"cv_{index:04d}" for index in range(1, len(excerpts) + 1)
    ]
    assert all(1 <= len(item["text"]) <= MAX_EVIDENCE_CHARS
               for item in excerpts)


def test_sentence_boundaries_keep_evidence_specific_and_context_visible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cv = (
        "Education: Diploma in media studies. "
        "Projects: Deployed services on Ubuntu. "
        "Training: Machine-learning course."
    )
    job = (
        "Linux deployment required. "
        "A degree in Engineering required. "
        "Machine-learning experience preferred."
    )
    cv_items = source_excerpts(cv, "cv")
    job_items = source_excerpts(job, "job")
    assert len(cv_items) == len(job_items) == 3
    assert "".join(item["text"] for item in cv_items) == cv
    assert "".join(item["text"] for item in job_items) == job
    output = {
        "matched_requirements": [{
            "requirement": "Linux deployment",
            "cv_evidence_id": cv_items[1]["id"],
            "job_evidence_id": job_items[0]["id"],
        }],
        "possible_gaps": [{
            "requirement": "Engineering degree",
            "job_evidence_id": job_items[1]["id"],
            "status": "not_found_in_cv",
        }],
    }
    calls = mock_provider(monkeypatch, output)

    result = compare(cv, job, ProviderSettings("test-key", "gpt-4o-mini"))

    assert isinstance(result, ComparisonResult)
    match = result.matched_requirements[0]
    assert match.cv_evidence == cv_items[1]["text"]
    assert match.job_evidence == job_items[0]["text"]
    assert "Diploma" not in match.cv_evidence
    assert "degree" not in match.job_evidence
    assert result.possible_gaps[0].job_evidence == job_items[1]["text"]
    assert set(result.model_dump()) == {
        "matched_requirements", "possible_gaps", "interpretation",
    }
    assert "evidence_id" not in result.model_dump_json()
    catalog = json.loads(calls[0]["input"][1]["content"])
    assert catalog == {
        "cv_excerpts": cv_items, "job_excerpts": job_items,
    }


def test_single_line_wrap_does_not_remove_negation() -> None:
    source = "Experience: I have not\nused Linux professionally."
    excerpts = source_excerpts(source, "cv")

    assert len(excerpts) == 1
    assert excerpts[0]["text"] == source


def test_pdf_style_blank_lines_do_not_fragment_cv_evidence() -> None:
    source = "Experience: not\n\nused Linux\n\nprofessionally."
    excerpts = source_excerpts(source, "cv")

    assert len(excerpts) == 1
    assert excerpts[0]["text"] == source


def test_long_unbroken_source_is_partitioned_without_loss() -> None:
    cv = "X" * 12_000
    job = "Y" * 8_000
    cv_items = source_excerpts(cv, "cv")
    job_items = source_excerpts(job, "job")

    assert "".join(item["text"] for item in cv_items) == cv
    assert "".join(item["text"] for item in job_items) == job
    assert all(len(item["text"]) <= 240 for item in cv_items + job_items)
    assert cv_items[-1]["id"] == f"cv_{len(cv_items):04d}"
    assert job_items[-1]["id"] == f"job_{len(job_items):04d}"
    check_input_limits(cv, job)


@pytest.mark.parametrize("start,end", [(1190, 2077), (1430, 2045)])
def test_observed_legacy_offsets_are_not_accepted_as_new_evidence(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    start: int,
    end: int,
) -> None:
    # The private capture contained these two overlong ranges. No source
    # text from that request is retained in this regression fixture.
    assert end - start > MAX_EVIDENCE_CHARS
    output = {
        "matched_requirements": [{
            "requirement": "Synthetic skill",
            "cv_evidence_id": "cv_0001",
            "cv_start": start,
            "cv_end": end,
            "job_evidence_id": "job_0001",
            "job_start": 0,
            "job_end": 20,
        }],
        "possible_gaps": [],
    }
    mock_provider(monkeypatch, output)

    with pytest.raises(InvalidProviderOutput):
        compare(
            "Synthetic CV evidence.", "Synthetic job requirement.",
            ProviderSettings("test-key", "gpt-4o-mini"),
        )
    assert '"category": "schema_validation"' in caplog.text
    assert '"field": "$.matched_requirements[0].<extra>"' in caplog.text


def test_same_requirement_cannot_be_match_and_gap(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    output = {
        "matched_requirements": [{
            "requirement": "Linux experience",
            "cv_evidence_id": "cv_0001",
            "job_evidence_id": "job_0001",
        }],
        "possible_gaps": [{
            "requirement": " Linux  experience ",
            "job_evidence_id": "job_0001",
            "status": "not_found_in_cv",
        }],
    }
    mock_provider(monkeypatch, output)

    with pytest.raises(InvalidProviderOutput):
        compare(
            "Worked with Linux.", "Linux experience required.",
            ProviderSettings("test-key", "gpt-4o-mini"),
        )
    assert '"category": "conflicting_classification"' in caplog.text
    assert '"field": "$.possible_gaps[0].requirement"' in caplog.text
