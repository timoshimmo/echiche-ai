import Link from "next/link";
import { LEGAL, SUPPORT } from "@/lib/domain/site";
import { SiteFooter } from "../site-footer";
import { PublicHeader } from "../ui/public-header";

export const metadata = { title: "Privacy notice" };

/**
 * Privacy notice (M9 P0-1). Every factual statement here mirrors docs/security/data-lifecycle.md;
 * change both together. Confirmed by the product owner on 3 November 2026 (operator, retention, reply time).
 */
export default function PrivacyPage() {
  return (
    <div className="public-page">
    <PublicHeader />
    <main className="legal" id="main">
      {LEGAL.privacyStatus === "draft" && (
        <div className="notice notice-warning" role="note">Draft for legal review. Items in [brackets] are still to be confirmed.</div>
      )}
      <h1>Privacy notice</h1>
      <p className="legal-meta">Last updated {LEGAL.privacyUpdated}</p>

      <h2>Who we are</h2>
      <p>
        Echiche is operated by {LEGAL.operator}, the data controller for the personal data described here. Contact us about privacy at <a href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a>.
      </p>

      <h2>What we collect and why</h2>
      <ul>
        <li><b>Account:</b> your email address, a securely hashed password (we never see or store the password itself) and
          sign-in records. If you continue with Google, Google tells us your email address and basic profile (name and picture);
          we use only the email address to identify your account.</li>
        <li><b>Your projects and decisions:</b> project titles and descriptions, the questions you ask, the briefs Echiche produces,
          memories you approve or add, decision versions and outcomes. This is the service itself: we process it to give you decision
          support and to keep your project&rsquo;s history.</li>
        <li><b>Files and links you attach</b> to a question: the text Echiche reads from them (documents, spreadsheets, PDFs, Word
          files, images and linked web pages), their names and sizes. Echiche uses this only to think through that question. The
          original file is not kept, and images are deleted once they have been read.</li>
        <li><b>Research material</b> (when research is on): the search queries Echiche writes from your question, and short passages
          from public web pages it reads, with their links and dates, so every cited claim can be checked.</li>
        <li><b>Usage and security records:</b> run costs, token counts and timings, and logs of actions such as exports and deletions,
          tied to a random account ID (never your email or content), to keep costs bounded, prevent abuse and investigate problems.</li>
      </ul>
      <p>
        We process this to provide the service you asked for (performance of our agreement with you) and, for usage and security
        records, for our legitimate interest in running a safe service. Where we rely on your consent, you can withdraw it at any time. We do not sell
        your data, show advertising, or use your content to train AI models.
      </p>

      <h2 id="google">If you sign in with Google</h2>
      <p>&ldquo;Continue with Google&rdquo; is optional; you can use an email address and password instead.</p>
      <ul>
        <li><b>What we receive:</b> only the basic sign-in information Google shares for the <code>openid</code>, <code>email</code> and{" "}
          <code>profile</code> permissions: your email address, whether Google has verified it, your name, your profile picture
          address and a Google account identifier. We do not ask for, and cannot reach, your Gmail, Drive, Calendar, contacts or any
          other Google data.</li>
        <li><b>How we use it:</b> only to create your Echiche account, sign you in and recognise you on later visits. Your email
          address identifies your account and is used for account emails such as password resets.</li>
        <li><b>Where it is stored:</b> with your sign-in record at our authentication provider, Supabase (Frankfurt, Germany),
          encrypted in transit and at rest.</li>
        <li><b>Sharing:</b> we do not sell Google user data, share it with anyone else, use it for advertising, or use it to train
          AI models. It is not sent to OpenAI or Brave Search.</li>
        <li><b>Keeping and deleting it:</b> we keep it while your account is open. Ask us at{" "}
          <a href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a> to close your account and we delete it. You can also remove
          Echiche&rsquo;s access at any time in your Google Account under &ldquo;Third-party apps &amp; services&rdquo;.</li>
      </ul>
      <p>
        Echiche&rsquo;s use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener noreferrer">Google API Services User
        Data Policy</a>, including the Limited Use requirements.
      </p>

      <h2>AI and automated processing</h2>
      <p>
        Briefs are generated by an AI model from your inputs. They are suggestions for you to review: nothing is decided for you,
        and nothing Echiche proposes to remember is saved until you approve it. Each result is labelled with how it was produced (a named AI model, or a
        deterministic demo with no AI).
      </p>

      <h2>Who receives your data</h2>
      <ul>
        <li><b>Google</b>, only if you choose &ldquo;Continue with Google&rdquo;: Google learns that you signed in to Echiche.</li>
        <li><b>Supabase</b> (database and sign-in) and <b>Render</b> (application hosting), both in Frankfurt, Germany.</li>
        <li><b>OpenAI</b>, to generate briefs: your project title and description, your question and the run&rsquo;s intermediate
          results are sent to its API, together with the text of anything you attach and any images you attach. OpenAI does not use API data for training by default and keeps abuse-monitoring logs for up
          to 30 days; we ask it not to store application state for our requests.</li>
        <li><b>Brave Search</b>, only when research is on: short search queries Echiche writes from its framing of your question. They can reflect details from your project or attachments, but never include the files themselves.
          Public web pages, including links you attach, are fetched by Echiche&rsquo;s server directly, so those websites see a
          request from Echiche, not from you.</li>
      </ul>
      <p>
        Some of these providers process data outside Nigeria (in the European Union and the United States). These
        transfers are covered by our providers&rsquo; data processing agreements, which include contractual safeguards such as
        standard contractual clauses, as the Nigeria Data Protection Act 2023 requires.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Projects, runs (including what was read from your attachments), memories and decisions: until you delete them in the
          app, or until your account is closed.</li>
        <li>Deleting a memory removes all its versions; deleting a project removes everything in it. Deleted data can remain in
          encrypted backups for up to 30 days before it is overwritten.</li>
        <li>Usage records used for abuse limits: about 30 days. Application logs, which never contain your content or email address: up to 30 days.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can access and export your data (&ldquo;Export project data&rdquo; downloads a machine-readable copy), correct it
        (memories and decisions can be corrected in the app), and delete it (memories and projects in the app; ask us to close your
        account and delete everything). You can also object to or ask us to restrict processing, and withdraw any consent you gave.
        Contact <a href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a>; we reply within 30 days.
        If you are unhappy with our answer, you can complain to the Nigeria Data Protection Commission, or the data protection authority where you live.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit and at rest by our providers. Each account can reach only its own data, enforced in the
        application and in the database. If we learn of a breach that affects you, we will tell you and the regulator as the law
        requires.
      </p>

      <h2>Cookies</h2>
      <p>
        Echiche uses only the cookies it needs to sign you in and keep you signed in securely. We use no advertising, analytics or
        tracking cookies, and no third-party trackers.
      </p>

      <h2>Changes</h2>
      <p>We will tell you in the app before material changes take effect.</p>

      <p><Link href="/">Back to Echiche</Link> · <Link href="/terms">Terms</Link></p>
    </main>
    <SiteFooter />
    </div>
  );
}
