// Publication requires owner confirmation of the visibly flagged facts below.
// Keep operational evidence and the private readiness report out of this page.
export function PrivacyPolicy() {
  return <article className="privacy-policy" aria-label="Privacy notice">
    <p className="privacy-policy__intro">
      Job Comparer helps you compare your CV with a job description and keep
      the results in your account. This notice explains what happens to your
      information when you use the service.
    </p>

    <aside className="privacy-policy__draft" aria-label="Policy review status">
      <strong>Draft for owner review</strong>
      <p>
        This notice is being finalised. The lawful bases and outstanding
        provider and retention details still need confirmation before publication.
      </p>
    </aside>

    <section aria-labelledby="privacy-controller">
      <h2 id="privacy-controller">Controller and contact</h2>
      <p>
        Job Comparer is a personal portfolio project operated by John Moran,
        an individual based in Ireland. It is not operated through a registered
        company. John Moran is responsible for how your personal information
        is used (the data controller).
      </p>
      <p>
        For privacy questions or requests about your personal data, email{' '}
        <a href="mailto:privacy@jobcomparer.com">privacy@jobcomparer.com</a>.
      </p>
    </section>

    <section aria-labelledby="privacy-information">
      <h2 id="privacy-information">Information we handle</h2>
      <ul>
        <li><strong>Your account:</strong> your email address, a password hash
          rather than a readable password, account identifiers and email
          verification status. Sign-in and verification records help manage
          access and expiry.</li>
        <li><strong>Your CV:</strong> text you paste or text extracted from a
          PDF or DOCX you upload. This can include your name, contact details,
          education, employment history, qualifications and anything else you include.</li>
        <li><strong>Saved jobs:</strong> job title, company name, description
          and a source link if supplied.</li>
        <li><strong>Comparison history:</strong> generated assessments, supporting
          excerpts from the CV and job description, the comparison time and a
          reference to the CV version used.</li>
        <li><strong>Security and service records:</strong> IP addresses, hashed
          email identifiers, request counts and times, AI usage counts and
          technical and email-delivery information.</li>
      </ul>
      <p>
        Only provide information needed for the comparison. Remove unnecessary
        contact details and information about other people. Do not include
        sensitive information such as health details, religious beliefs or
        government identification numbers. The service does not automatically
        remove personal information from your text before processing it.
      </p>
      <p>
        An email address and password are needed for a saved account. A CV and
        job description are needed for a comparison; you can browse the public
        pages without providing them.
      </p>
    </section>

    <section aria-labelledby="privacy-purposes">
      <h2 id="privacy-purposes">Why your information is used</h2>
      <p>
        Information is used for the purposes below. The proposed GDPR lawful
        bases still need to be confirmed before this notice is finalised.
      </p>
      <ul>
        <li><strong>Providing the service you request:</strong> verifying your
          email, signing you in, saving your information and comparing your CV
          with a job. Proposed basis: processing necessary to provide the
          agreed service (performance of a contract).</li>
        <li><strong>Protecting the service:</strong> preventing unauthorised
          access, limiting abuse and usage, and keeping deletion records for
          backup recovery. Proposed basis: legitimate interests in protecting
          accounts and keeping the service available, balanced against your rights.</li>
        <li><strong>Handling privacy requests:</strong> responding to requests
          about your data. Proposed basis: complying with applicable
          data-protection obligations.</li>
      </ul>
      <p>
        Sensitive information, such as health details, needs additional legal
        protection. These proposed bases alone do not authorise its processing.
      </p>
    </section>

    <section aria-labelledby="privacy-ai">
      <h2 id="privacy-ai">AI comparisons</h2>
      <p>
        When you request a comparison, the saved CV text and the selected job
        description are sent to OpenAI’s API. This includes the full text, not
        just a summary, and any identifying details it contains. Simply viewing
        a saved result does not request another AI comparison.
      </p>
      <p>
        The AI looks for evidence in your CV that matches job requirements.
        Results can contain mistakes or miss relevant experience. Job Comparer
        does not submit applications, contact employers or make hiring decisions.
      </p>
      <p>
        Requests disable OpenAI’s optional response storage. This does not mean
        zero provider retention. OpenAI’s published API policy says data is not
        used for model training by default unless the customer opts in, but
        security and abuse-monitoring records may still retain content.
        Job Comparer’s provider settings need confirmation. See{' '}
        <a href="https://developers.openai.com/api/docs/guides/your-data">
          OpenAI’s API data controls
        </a> for the provider’s explanation.
      </p>
    </section>

    <section aria-labelledby="privacy-providers">
      <h2 id="privacy-providers">Service providers, storage and transfers</h2>
      <p>
        Account data and saved content are stored in a PostgreSQL database on
        Amazon Web Services (AWS). AWS also hosts the application, private backups
        and account-deletion records. OpenAI processes comparisons. An email
        provider sends verification and account-guidance messages to your address;
        those emails do not contain your CV or job descriptions.
      </p>
      <p>
        The email provider, processing locations and provider agreements still
        need confirmation. If providers process information outside the European
        Economic Area, the relevant countries and legal safeguards must be
        explained in the final notice. No EU-only processing guarantee is made.
      </p>
      <p>
        Password hashing, session checks and account-level access controls help
        protect your information. Production cookie settings require HTTPS, and
        email uses an encrypted connection to the mail provider. No service can
        guarantee absolute security.
      </p>
    </section>

    <section aria-labelledby="privacy-retention">
      <h2 id="privacy-retention">Retention and deletion</h2>
      <ul>
        <li><strong>Uploaded documents:</strong> the server extracts text from your
          PDF or DOCX and closes the upload after processing. The saved CV is
          text, not a stored copy of the original document. Temporary storage
          may be used during the upload; immediate secure erasure of every
          temporary copy is not guaranteed.</li>
        <li><strong>Saved CV:</strong> the current text stays until you replace it,
          delete it in My CV or successfully delete your account. Replacing or
          deleting it does not remove excerpts from earlier comparisons.</li>
        <li><strong>Jobs and results:</strong> saved jobs and comparisons do not
          currently expire automatically. Deleting a job also deletes its saved
          comparisons. Deleting a single comparison removes that saved result
          and its excerpts, but leaves your job and current CV.</li>
        <li><strong>Your account:</strong> use Delete account in Account settings
          and confirm your password. Successful deletion removes your account,
          current CV, jobs, comparisons, sessions and verification tokens from
          the live database and signs you out on all devices. A pending or
          unconfirmed response does not mean deletion has finished.</li>
        <li><strong>Security and deletion records:</strong> some IP-address and
          hashed-email anti-abuse records remain after account deletion. A separate
          deletion record keeps an account identifier and timestamps for backup
          recovery, not your email or CV. These records are not anonymous.
          Old sign-in, verification, usage and deletion records have no automated
          cleanup schedule yet; retention limits still need to be set.</li>
      </ul>
      <p>
        Daily database backups are kept separately. The configured expiry is
        30 days for current backup copies and one day after a version becomes
        noncurrent. Removal is not immediate when those periods end, so this
        is not a guaranteed 31-day erasure deadline. The deployed settings and
        log-retention periods still need confirmation.
      </p>
      <p>
        Deletion from the live database does not immediately erase backups or
        provider records, or cancel requests already sent to an external service.
        Account-deletion records support backup recovery; equivalent protection
        for individually deleted CVs, jobs and comparisons is not yet complete.
        A recorded account-deletion request cannot be cancelled. Pending requests
        are not automatically completed or reported to the operator.
      </p>
    </section>

    <section aria-labelledby="privacy-cookies">
      <h2 id="privacy-cookies">Cookies and browser storage</h2>
      <p>
        An essential session cookie keeps you signed in. It contains a random
        token, not your CV or password. It expires according to the server’s
        session setting: one hour by default, with the live value still to be
        confirmed. Logging out ends that session and clears the cookie. Blocking
        it prevents signed-in features from working.
      </p>
      <p>
        Unsaved text and selected files stay in the open app’s memory while you
        navigate, but are not preserved after a fresh page load. The application
        includes no advertising or analytics cookies; any additions on the live
        website still need checking.
      </p>
    </section>

    <section aria-labelledby="privacy-rights">
      <h2 id="privacy-rights">Your rights</h2>
      <p>
        Under the GDPR, you can ask for a copy of your personal data, correction
        of inaccurate information, deletion or limits on its use. Where applicable,
        you can request a portable copy or object to processing based on legitimate
        interests. If processing relies on consent, you can withdraw it without
        affecting earlier lawful processing. These rights have conditions and exceptions.
      </p>
      <p>
        You do not have to use the in-app deletion controls to exercise your
        rights, including if you cannot sign in. Use the privacy email above.
        Reasonable identity checks may be needed; never send your password.
        The app does not currently offer a self-service account export.
      </p>
      <p>
        GDPR requests normally require a response within one month and are
        generally free. A necessary extension of up to two further months
        requires an explanation within the first month. See the{' '}
        <a href="https://dataprotection.ie/en/individuals/exercising-your-rights/how-long-will-it-take">
          Data Protection Commission’s guidance on response times
        </a>.
      </p>
      <p>
        You can complain to a data-protection authority, including where you
        live or work. In Ireland, you can{' '}
        <a href="https://www.dataprotection.ie/en/individuals/exercising-your-rights/raising-concern-commission">
          raise a concern with the Data Protection Commission
        </a>. This does not depend on using the account-deletion feature.
      </p>
    </section>
  </article>;
}
