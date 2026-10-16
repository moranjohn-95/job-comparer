export function TermsOfUse({ onOpenPrivacy }: { onOpenPrivacy: () => void }) {
  return <article className="terms-of-use" aria-label="Terms of use">
    <p className="terms-of-use__intro">
      These terms explain what you can expect from Job Comparer and how to use
      it responsibly.
    </p>

    <section aria-labelledby="terms-service">
      <h2 id="terms-service">What Job Comparer provides</h2>
      <p>
        Job Comparer is a personal portfolio application that helps you save a
        CV, organise job descriptions and generate AI-assisted comparisons.
        You can keep comparison results in your account for later review.
        It is not a recruitment agency and does not submit applications,
        contact employers or make hiring decisions.
      </p>
    </section>

    <section aria-labelledby="terms-ai">
      <h2 id="terms-ai">AI guidance, not a guarantee</h2>
      <p>
        Comparisons are informational guidance, not a definitive assessment of
        your skills or a job. AI can make mistakes, miss relevant experience
        or misunderstand the information provided. Results do not guarantee
        an interview, employment or suitability for a role.
      </p>
      <p>
        Check results against your original CV and the job description before
        relying on them. Use your own judgement and do not use a comparison
        as the sole basis for decisions affecting someone’s employment.
      </p>
    </section>

    <section aria-labelledby="terms-information">
      <h2 id="terms-information">Your information and account</h2>
      <p>
        You are responsible for the information you upload or paste and for
        having the right to use it. Do not submit material that infringes
        someone else’s rights, misrepresents your experience or includes
        unnecessary personal information about other people. Only include
        information needed for the comparison.
      </p>
      <p>
        Keep your sign-in details secure and do not share your password. Keep
        your own copies of important documents and results; Job Comparer
        should not be your only place to store them.
      </p>
    </section>

    <section aria-labelledby="terms-use">
      <h2 id="terms-use">Acceptable use</h2>
      <p>Use the service lawfully. Do not:</p>
      <ul>
        <li>Try to access another person’s account or data, or bypass
          authentication, security controls or usage limits.</li>
        <li>Upload malicious files or use excessive automated requests to
          disrupt the service or interfere with other users.</li>
        <li>Use the service for fraud, impersonation, harassment or unlawful
          discrimination, or submit illegal content.</li>
      </ul>
    </section>

    <section aria-labelledby="terms-availability">
      <h2 id="terms-availability">Availability and changes</h2>
      <p>
        Job Comparer is an evolving project. Features may change, be paused
        or be discontinued. Access can be interrupted by maintenance,
        security issues or problems with third-party services, including
        the AI provider. Continuous availability and continued support for
        a particular feature are not guaranteed.
      </p>
    </section>

    <section aria-labelledby="terms-responsibility">
      <h2 id="terms-responsibility">Responsibility</h2>
      <p>
        Job Comparer cannot promise error-free results or a particular
        employment outcome. You remain responsible for checking results
        and deciding how to use them.
      </p>
      <p>
        Nothing in these terms excludes or limits any rights or responsibilities
        that cannot lawfully be excluded or limited, including applicable
        consumer and data-protection rights.
      </p>
    </section>

    <section aria-labelledby="terms-privacy">
      <h2 id="terms-privacy">Privacy</h2>
      <p>
        The{' '}
        <a href={`${import.meta.env.BASE_URL}privacy`} onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpenPrivacy();
        }}>Privacy Policy</a>{' '}
        explains how account details, CVs, job descriptions and comparisons
        are processed, including AI processing, retention, deletion and
        your rights. Using Job Comparer does not waive those rights.
      </p>
    </section>
  </article>;
}
