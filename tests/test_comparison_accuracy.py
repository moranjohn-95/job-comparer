"""Prompt/payload contracts, not a simulation of model reasoning.

Synthetic expected outputs keep the requested distinctions reviewable. The
mock returns them verbatim; a real model must still be evaluated against
these examples to establish whether it follows the instructions.
"""

import json
import re

import httpx
import pytest

from comparison import (
    MAX_CV_CHARS,
    ComparisonInputTooLong,
    ProviderSettings,
    _is_excerpt,
    check_input_limits,
    compare,
    source_excerpts,
)


@pytest.mark.parametrize(
    "cv,job,matches,gaps,rules",
    [
        pytest.param(
            "Technical skills: Python. Built Python services.",
            "Python AND C++ required.",
            [("Python (part of Python AND C++)", "Built Python services")],
            ["C++ (part of Python AND C++)"],
            [
                "Assess independently testable parts",
                "Preserve AND/OR wording",
                "Evidence for one distinct skill does not establish another",
            ],
            id="and-does-not-transfer-python-evidence-to-cpp",
        ),
        pytest.param(
            "Built Python services.",
            "Python OR C++ required.",
            [("Python OR C++ (Python supported)", "Built Python services")],
            [],
            [
                "one supported alternative can satisfy the group",
                "do not turn the other alternatives into mandatory",
            ],
            id="or-does-not-make-every-alternative-mandatory",
        ),
        pytest.param(
            "Skills: Python and C++. Completed a Python and C++ project.",
            "At least 3 years of professional experience in Python AND C++.",
            [],
            [
                "At least 3 years of professional Python experience (AND)",
                "At least 3 years of professional C++ experience (AND)",
            ],
            [
                "minimum years, professional experience",
                "Carry applicable qualifiers into each separately",
                "do not by themselves establish years of professional",
                "Do not weaken a requirement to make it match",
            ],
            id="projects-and-skills-do-not-establish-professional-duration",
        ),
        pytest.param(
            "Experience: Maintained reporting tools.\n"
            "Education: Diploma in computing.\n"
            "Training: Statistics course.\n"
            "Projects: Trained and evaluated a random forest classifier.",
            "Machine-learning AND deep-learning experience required.",
            [(
                "Machine-learning experience (AND deep learning)",
                "Trained and evaluated a random forest classifier",
            )],
            ["Deep-learning experience (AND machine learning)"],
            [
                "Read the entire supplied CV",
                "projects, technical skills, education, and training",
                "even at the end of the text",
                "Relevant project evidence can support",
                "Broad knowledge or experience does not establish",
                "require evidence specific to the requested specialisation",
            ],
            id="late-project-supports-ml-but-not-deep-learning",
        ),
        pytest.param(
            "Education: Diploma in software engineering.",
            "A bachelor's degree in software engineering is required.",
            [],
            ["Required bachelor's degree in software engineering"],
            [
                "Do not assume equivalence between qualification types",
                "Match only the stated qualification type, level, and field",
                "Do not invent credential equivalence",
            ],
            id="diploma-does-not-establish-required-degree",
        ),
        pytest.param(
            "Education: Diploma in software engineering.",
            "A degree OR diploma in software engineering is required.",
            [(
                "Degree OR diploma in software engineering (diploma)",
                "Diploma in software engineering",
            )],
            [],
            ["an alternative explicitly allowed by the job"],
            id="explicitly-allowed-diploma-is-not-discarded",
        ),
        pytest.param(
            "Built Python APIs. Led a documentation workshop.",
            "C++ development required.",
            [],
            ["Required C++ development"],
            [
                "Source provenance alone does not establish semantic",
                "Never select unrelated genuine evidence to justify a match",
                "directly support every part and qualifier of the claim",
            ],
            id="genuine-but-unrelated-quote-cannot-support-claim",
        ),
        pytest.param(
            "I have not used C++; I plan to study it next year.",
            "C++ development required.",
            [],
            ["Required C++ development"],
            [
                "Check the excerpt in context for negation, aspirations",
                "recheck every match against the complete supporting CV",
            ],
            id="negation-and-aspiration-are-not-experience",
        ),
        pytest.param(
            "Education: Level 2 hospitality qualification.\n"
            "Training: General catering course.\n"
            "Projects: Prepared pastries for a community event.",
            "Pastry AND bread preparation required. "
            "Specialised allergen-safe catering knowledge required. "
            "Level 3 food safety qualification required.",
            [(
                "Pastry preparation (part of pastry AND bread preparation)",
                "Prepared pastries for a community event",
            )],
            [
                "Bread preparation (part of pastry AND bread preparation)",
                "Specialised allergen-safe catering knowledge",
                "Required Level 3 food safety qualification",
            ],
            [
                "across occupations, industries, skills, and qualification",
                "Preserve AND/OR wording",
                "Evidence for one distinct skill does not establish another",
                "Relevant project evidence can support",
                "Broad knowledge or experience does not establish",
                "require evidence specific to the requested specialisation",
                "Match only the stated qualification type, level, and field",
                "directly support every part and qualifier of the claim",
            ],
            id="catering-skills-specialisation-and-qualification-level-field",
        ),
    ],
)
def test_accuracy_instructions_and_synthetic_response_contract(
    monkeypatch: pytest.MonkeyPatch,
    cv: str,
    job: str,
    matches: list[tuple[str, str]],
    gaps: list[str],
    rules: list[str],
) -> None:
    cv_catalog = source_excerpts(cv, "cv")
    job_catalog = source_excerpts(job, "job")
    job_item = job_catalog[0]
    selected = [
        next(item for item in cv_catalog if quote in item["text"])
        for _, quote in matches
    ]
    expected = {
        "matched_requirements": [
            {
                "requirement": label, "cv_evidence": item["text"],
                "job_evidence": job_item["text"],
            }
            for (label, _), item in zip(matches, selected)
        ],
        "possible_gaps": [
            {
                "requirement": label, "job_evidence": job_item["text"],
                "status": "not_found_in_cv",
            }
            for label in gaps
        ],
        "needs_review": [],
    }
    labels = [label for label, _ in matches] + gaps
    references = {
        "inventory_complete": True,
        "requirements": [
            {
                "id": f"req_{index:04d}", "requirement": label,
                "job_evidence_id": job_item["id"],
            }
            for index, label in enumerate(labels, start=1)
        ],
        "assessments": [
            {
                "requirement_id": f"req_{index:04d}",
                "status": "matched", "cv_evidence_id": item["id"],
                "reason": "",
            }
            for index, item in enumerate(selected, start=1)
        ] + [
            {
                "requirement_id": f"req_{index:04d}",
                "status": "not_found_in_cv", "cv_evidence_id": "",
                "reason": "",
            }
            for index in range(len(matches) + 1, len(labels) + 1)
        ],
    }
    payloads = []

    def fake_post(*_: object, **kwargs: object) -> httpx.Response:
        payloads.append(kwargs["json"])
        return httpx.Response(
            200,
            request=httpx.Request("POST", "https://example.test"),
            json={
                "status": "completed",
                "output": [{
                    "type": "message",
                    "content": [{
                        "type": "output_text", "text": json.dumps(references),
                    }],
                }],
            },
        )

    monkeypatch.setattr("comparison._post_once", fake_post)
    result = compare(cv, job, ProviderSettings("test-key", "gpt-4o-mini"))

    assert len(payloads) == 1
    system_message, user_message = payloads[0]["input"]
    assert system_message["role"] == "system"
    for rule in rules:
        assert rule in system_message["content"]
    assert user_message["role"] == "user"
    assert json.loads(user_message["content"]) == {
        "cv_excerpts": [
            {**item, "text": re.sub(r"\s+", " ", item["text"])}
            for item in cv_catalog
        ],
        "job_excerpts": job_catalog,
    }
    assert result.model_dump(exclude={"interpretation"}) == expected
    assert "does not establish" in result.interpretation
    assert payloads[0]["text"]["format"]["strict"] is True


def test_excerpt_membership_cannot_establish_semantic_support() -> None:
    # This genuine quote supplies no evidence for C++. Provenance alone
    # cannot reject a semantically incorrect provider classification.
    assert _is_excerpt("Built Python APIs", "Projects: Built Python APIs.")
    assert not _is_excerpt("Built C++ APIs", "Projects: Built Python APIs.")


def test_cv_limit_rejects_whole_input_instead_of_clipping_sections() -> None:
    final_section = "\nProjects: Built a machine-learning classifier."
    cv = "x" * (MAX_CV_CHARS - len(final_section)) + final_section
    check_input_limits(cv, "Machine-learning experience required.")
    with pytest.raises(ComparisonInputTooLong):
        check_input_limits("x" + cv, "Machine-learning experience required.")
