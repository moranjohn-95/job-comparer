"""Conservative quote membership regressions using synthetic text."""

import pytest

from comparison import _is_excerpt


@pytest.mark.parametrize(
    "source,quote,accepted",
    [
        pytest.param(
            "Experience:\nPrepared\nmonthly\r\nreports.",
            "Prepared monthly reports.", True, id="source-line-wraps",
        ),
        pytest.param(
            "Prepared monthly reports.", "Prepared\nmonthly\r\nreports.",
            True, id="quote-line-wraps",
        ),
        pytest.param(
            "Prepared\tmonthly\t\treports.", "Prepared monthly reports.",
            True, id="table-tabs",
        ),
        pytest.param(
            "  Prepared   monthly    reports.  ",
            " Prepared monthly reports. ", True, id="repeated-spaces",
        ),
        pytest.param(
            "Prepared\u00a0monthly\u00a0reports.",
            "Prepared monthly reports.", True, id="source-nonbreaking-spaces",
        ),
        pytest.param(
            "Prepared monthly reports.",
            "Prepared\u00a0monthly\u00a0reports.",
            True, id="quote-nonbreaking-spaces",
        ),
        pytest.param(
            "Prepared\u202fmonthly\u202freports.",
            "Prepared monthly reports.", True, id="narrow-nonbreaking-spaces",
        ),
        pytest.param(
            "Prepared\n\t\u00a0monthly  reports.",
            "Prepared monthly\u202f\nreports.",
            True, id="mixed-whitespace-on-both-sides",
        ),
        pytest.param(
            "Prepared monthly reports.", "Prepared annual reports.",
            False, id="changed-word",
        ),
        pytest.param(
            "Prepared monthly reports.", "Produced reports every month.",
            False, id="paraphrase",
        ),
        pytest.param(
            "I have not prepared monthly reports.",
            "I have prepared monthly reports.", False, id="removed-negation",
        ),
        pytest.param(
            "I have prepared monthly reports.",
            "I have not prepared monthly reports.", False, id="added-negation",
        ),
        pytest.param(
            "Managed logistics.\nTraining: food safety.\nPrepared reports.",
            "Managed logistics. Prepared reports.", False, id="stitched",
        ),
        pytest.param(
            "Managed logistics.\nTraining: food safety.\nPrepared reports.",
            "Managed logistics. ... Prepared reports.",
            False, id="stitched-with-ellipsis",
        ),
        pytest.param(
            "Prepared monthly reports.", "Preparedmonthly reports.",
            False, id="removed-word-boundary",
        ),
        pytest.param(
            "Provided non-clinical support.", "Provided nonclinical support.",
            False, id="removed-punctuation",
        ),
        pytest.param(
            "Performed risk-\nassessment.", "Performed risk-assessment.",
            False, id="no-automatic-dehyphenation",
        ),
        pytest.param(
            "Prepared monthly reports.", "\n\u00a0\t",
            False, id="whitespace-only-quote",
        ),
    ],
)
def test_evidence_provenance_and_original_text_are_preserved(
    source: str,
    quote: str,
    accepted: bool,
) -> None:
    assert _is_excerpt(quote, source) is accepted
