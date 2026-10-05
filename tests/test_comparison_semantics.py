"""Synthetic semantic scenarios; mocks do not establish model accuracy."""

import json

import httpx
import pytest

from comparison import ProviderSettings, compare, source_excerpts


def reference(text: str, source: str, quote: str) -> dict:
    excerpt = next(
        item for item in source_excerpts(text, source)
        if quote in item["text"]
    )
    return {f"{source}_evidence_id": excerpt["id"]}


@pytest.mark.parametrize(
    "cv,job,matches,gaps,rules",
    [
        pytest.param(
            "Education: Distinction Diploma in Full Stack Software "
            "Development. Projects: Built web applications.",
            "A degree in Computer Science, Engineering, or Applied "
            "Physics is required. Linux experience preferred.",
            [],
            [(
                "Required degree in Computer Science, Engineering, or "
                "Applied Physics",
                "A degree in Computer Science, Engineering, or Applied "
                "Physics is required.",
            )],
            [
                "Do not assume equivalence between qualification",
                "qualification type, level, and field",
            ],
            id="diploma-is-not-required-degree",
        ),
        pytest.param(
            "Experience: Deployed services on Ubuntu servers. "
            "Education: Diploma in networking.",
            "Linux deployment experience required. Degree preferred.",
            [(
                "Linux deployment experience",
                "Deployed services on Ubuntu servers.",
                "Linux deployment experience required.",
            )],
            [],
            [
                "Search all sections before reporting evidence as not found",
                "named distributions or implementations",
            ],
            id="ubuntu-can-evidence-linux",
        ),
        pytest.param(
            "Work: Maintained reports. Training: Machine-learning course. "
            "Projects: Trained a random forest classifier.",
            "Both Machine Learning / Deep Learning experience required. "
            "Database experience preferred.",
            [(
                "Machine-learning experience (one required part)",
                "Trained a random forest classifier.",
                "Both Machine Learning / Deep Learning experience required.",
            )],
            [(
                "Deep-learning experience (other required part)",
                "Both Machine Learning / Deep Learning experience required.",
            )],
            [
                "slash-separated phrase can mean alternatives or combined",
                "Do not combine a supported part and an unsupported part",
                "Never put the same requirement ID in both matches",
                "projects, technical skills, education, and training",
            ],
            id="machine-learning-found-deep-learning-gap",
        ),
        pytest.param(
            "Projects: Prepared pastries for a community event. "
            "Training: Level 2 food safety course.",
            "Pastry and bread preparation required. Level 3 food safety "
            "qualification required.",
            [(
                "Pastry preparation (required part)",
                "Prepared pastries for a community event.",
                "Pastry and bread preparation required.",
            )],
            [
                (
                    "Bread preparation (required part)",
                    "Pastry and bread preparation required.",
                ),
                (
                    "Level 3 food safety qualification",
                    "Level 3 food safety qualification required.",
                ),
            ],
            [
                "Assess independently testable parts",
                "Do not assume equivalence between qualification",
            ],
            id="non-software-skill-and-qualification-level",
        ),
    ],
)
def test_semantic_contract_and_relevant_excerpts(
    monkeypatch: pytest.MonkeyPatch,
    cv: str,
    job: str,
    matches: list[tuple[str, str, str]],
    gaps: list[tuple[str, str]],
    rules: list[str],
) -> None:
    criteria = [
        (label, job_quote) for label, _, job_quote in matches
    ] + gaps
    output = {
        "inventory_complete": True,
        "requirements": [
            {
                "id": f"req_{index:04d}", "requirement": label,
                **reference(job, "job", job_quote),
            }
            for index, (label, job_quote) in enumerate(
                criteria, start=1
            )
        ],
        "assessments": [
            {
                "requirement_id": f"req_{index:04d}",
                "status": "matched",
                **reference(cv, "cv", cv_quote),
            }
            for index, (_, cv_quote, _) in enumerate(matches, start=1)
        ] + [
            {
                "requirement_id": f"req_{index:04d}",
                "status": "not_found_in_cv", "cv_evidence_id": "",
            }
            for index in range(len(matches) + 1, len(criteria) + 1)
        ],
    }
    payloads = []

    def fake_post(*_: object, **kwargs: object) -> httpx.Response:
        payloads.append(kwargs["json"])
        return httpx.Response(
            200, request=httpx.Request("POST", "https://example.test"),
            json={
                "status": "completed",
                "output": [{
                    "type": "message", "content": [{
                        "type": "output_text", "text": json.dumps(output),
                    }],
                }],
            },
        )

    monkeypatch.setattr("comparison._post_once", fake_post)
    result = compare(cv, job, ProviderSettings("test-key", "gpt-4o-mini"))

    assert len(payloads) == 1
    prompt = payloads[0]["input"][0]["content"]
    for rule in rules:
        assert rule in prompt
    assert "most specific relevant excerpt" in prompt
    assert len(result.matched_requirements) == len(matches)
    assert len(result.possible_gaps) == len(gaps)
    for actual, (label, cv_quote, job_quote) in zip(
        result.matched_requirements, matches
    ):
        assert actual.requirement == label
        assert cv_quote in actual.cv_evidence
        assert job_quote in actual.job_evidence
        assert actual.cv_evidence in cv
        assert actual.job_evidence in job
    for actual, (label, job_quote) in zip(result.possible_gaps, gaps):
        assert actual.requirement == label
        assert job_quote in actual.job_evidence
        assert actual.job_evidence in job
    assert "cv_evidence_id" not in result.model_dump_json()
