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
        "inventory_complete": True,
        "requirements": [{
            "id": "req_0001", "requirement": "Linux deployment",
            "job_evidence_id": job_items[0]["id"],
        }, {
            "id": "req_0002", "requirement": "Engineering degree",
            "job_evidence_id": job_items[1]["id"],
        }],
        "assessments": [{
            "requirement_id": "req_0001", "status": "matched",
            "cv_evidence_id": cv_items[1]["id"],
        }, {
            "requirement_id": "req_0002",
            "status": "not_found_in_cv", "cv_evidence_id": "",
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


def test_bullet_boundaries_keep_requirements_local_without_loss() -> None:
    source = "Requirements:\n- Python development\n- Linux deployment"
    excerpts = source_excerpts(source, "job")

    assert "".join(item["text"] for item in excerpts) == source
    assert len(excerpts) == 3
    assert "Linux" not in excerpts[1]["text"]
    assert "Python" not in excerpts[2]["text"]


@pytest.mark.parametrize(
    "second_requirement,assessments,category",
    [
        (
            "Strong Python development skills",
            ["req_0001", "req_0002"],
            "duplicate_requirement",
        ),
        ("Linux deployment", ["req_0001"], "missing_assessment"),
    ],
)
def test_inventory_is_unique_and_fully_assessed(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    second_requirement: str,
    assessments: list[str],
    category: str,
) -> None:
    output = {
        "inventory_complete": True,
        "requirements": [
            {
                "id": f"req_{index:04d}", "requirement": label,
                "job_evidence_id": "job_0001",
            }
            for index, label in enumerate(
                ("Strong Python development skills", second_requirement),
                start=1,
            )
        ],
        "assessments": [
            {
                "requirement_id": identifier,
                "status": "not_found_in_cv", "cv_evidence_id": "",
            }
            for identifier in assessments
        ],
    }
    mock_provider(monkeypatch, output)

    with pytest.raises(InvalidProviderOutput):
        compare(
            "Worked with Python and Linux.",
            "Python and Linux deployment required.",
            ProviderSettings("test-key", "gpt-4o-mini"),
        )
    assert f'"category": "{category}"' in caplog.text


def test_unassessed_requirement_is_not_manufactured_as_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = {
        "inventory_complete": False,
        "requirements": [{
            "id": "req_0001", "requirement": "Linux deployment",
            "job_evidence_id": "job_0001",
        }],
        "assessments": [{
            "requirement_id": "req_0001", "status": "unassessed",
            "cv_evidence_id": "",
        }],
    }
    mock_provider(monkeypatch, output)

    result = compare(
        "Deployed on Ubuntu.", "Linux deployment required.",
        ProviderSettings("test-key", "gpt-4o-mini"),
    )

    assert result.matched_requirements == []
    assert result.possible_gaps == []
    assert "comparison is incomplete" in result.interpretation
    assert "Linux deployment" in result.interpretation
    assert "may omit criteria" in result.interpretation


def test_public_list_limit_marks_unshown_requirements_incomplete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = {
        "inventory_complete": True,
        "requirements": [
            {
                "id": f"req_{index:04d}",
                "requirement": f"Criterion {index}",
                "job_evidence_id": "job_0001",
            }
            for index in range(1, 12)
        ],
        "assessments": [
            {
                "requirement_id": f"req_{index:04d}",
                "status": "not_found_in_cv", "cv_evidence_id": "",
            }
            for index in range(1, 12)
        ],
    }
    mock_provider(monkeypatch, output)

    result = compare(
        "Synthetic CV.", "Synthetic criteria required.",
        ProviderSettings("test-key", "gpt-4o-mini"),
    )

    assert len(result.possible_gaps) == 10
    assert "comparison is incomplete" in result.interpretation
    assert "Criterion 11" in result.interpretation


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
        "inventory_complete": True,
        "requirements": [{
            "id": "req_0001", "requirement": "Synthetic skill",
            "job_evidence_id": "job_0001",
        }],
        "assessments": [{
            "requirement_id": "req_0001", "status": "matched",
            "cv_evidence_id": "cv_0001",
            "cv_start": start,
            "cv_end": end,
            "job_start": 0,
            "job_end": 20,
        }],
    }
    mock_provider(monkeypatch, output)

    with pytest.raises(InvalidProviderOutput):
        compare(
            "Synthetic CV evidence.", "Synthetic job requirement.",
            ProviderSettings("test-key", "gpt-4o-mini"),
        )
    assert '"category": "schema_validation"' in caplog.text
    assert '"field": "$.assessments[0].<extra>"' in caplog.text


def test_same_requirement_cannot_be_match_and_gap(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    output = {
        "inventory_complete": True,
        "requirements": [{
            "id": "req_0001", "requirement": "Linux experience",
            "job_evidence_id": "job_0001",
        }],
        "assessments": [{
            "requirement_id": "req_0001", "status": "matched",
            "cv_evidence_id": "cv_0001",
        }, {
            "requirement_id": "req_0001",
            "status": "not_found_in_cv",
            "cv_evidence_id": "",
        }],
    }
    mock_provider(monkeypatch, output)

    with pytest.raises(InvalidProviderOutput):
        compare(
            "Worked with Linux.", "Linux experience required.",
            ProviderSettings("test-key", "gpt-4o-mini"),
        )
    assert '"category": "duplicate_assessment"' in caplog.text
    assert '"field": "$.assessments[1].requirement_id"' in caplog.text
