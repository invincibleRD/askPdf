/**
 * The test corpus.
 *
 * Retrieval quality cannot be tested with one document about one thing. These
 * four cover deliberately unrelated domains, each with facts that appear in
 * exactly one of them, so a query can be checked for two failures at once:
 *
 *   - *recall*    — did the right passage come back at all?
 *   - *precision* — did a passage from an unrelated document come back too?
 *
 * The `probes` on each document are the assertions: `expected` questions must
 * retrieve that document's chunks with a score above the threshold, and
 * `offTopic` questions must fall below it so the service refuses instead of
 * inventing an answer.
 *
 * Text is written to be semantically distinctive rather than long. Shared
 * vocabulary between documents ("system", "process", "report") is kept low on
 * purpose — that is what makes a retrieval regression visible.
 */

export const CORPUS = Object.freeze([
  {
    slug: 'espresso-machine-manual',
    title: 'Rancilio Silvia Pro X — Service Manual',
    topic: 'espresso hardware maintenance',
    pages: [
      {
        heading: 'Boiler Descaling Procedure',
        paragraphs: [
          'The dual boiler system requires descaling every 600 shots or every three months, whichever comes first. Hard water above 150 ppm shortens this interval to 400 shots.',
          'Fill the water tank with a solution of 30 grams of citric acid dissolved in two litres of warm water. Never use vinegar: acetic acid attacks the brass fittings and voids the warranty.',
          'Run the descaling cycle by holding the steam and hot water buttons together for eight seconds until the middle indicator light blinks amber.',
        ],
      },
      {
        heading: 'Group Head Temperature Calibration',
        paragraphs: [
          'The PID controller ships calibrated to 93 degrees Celsius at the group head. Measuring at the portafilter basket typically reads 1.5 degrees lower because of thermal loss through the brass.',
          'To adjust the offset, enter service mode by powering on while holding the brew button. Rotate the encoder to change the offset in increments of 0.1 degrees between minus 5 and plus 5.',
          'A calibration drift greater than two degrees usually indicates a failing thermocouple rather than a controller fault. Replace part number 34400.021 before adjusting the offset further.',
        ],
      },
      {
        heading: 'Pump Pressure and Overpressure Valve',
        paragraphs: [
          'Static pump pressure is factory set to nine bar measured with a blind portafilter. The vibratory pump peaks near fifteen bar before the overpressure valve opens.',
          'Adjusting the overpressure valve clockwise raises the release point by roughly 0.5 bar per quarter turn. Do not exceed eleven bar; the boiler relief disc is rated for twelve.',
        ],
      },
    ],
    probes: {
      expected: [
        {
          question: 'How often should the boiler be descaled?',
          mustMatch: /600 shots|three months/i,
        },
        {
          question: 'What temperature is the PID controller calibrated to?',
          mustMatch: /93 degrees/i,
        },
        {
          question: 'What is the static pump pressure set to at the factory?',
          mustMatch: /nine bar/i,
        },
      ],
      offTopic: [
        'What were the quarterly revenue figures for the Nordic region?',
        'Which enzyme catalyses the third step of glycolysis?',
      ],
    },
  },

  {
    slug: 'quarterly-financial-report',
    title: 'Northwind Trading — Q3 Financial Report',
    topic: 'corporate finance',
    pages: [
      {
        heading: 'Revenue by Region',
        paragraphs: [
          'Consolidated revenue for the third quarter reached 48.2 million euros, an increase of 11 percent against the same quarter last year.',
          'The Nordic region contributed 14.6 million euros, overtaking the DACH region for the first time since the 2023 restructuring. DACH recorded 13.9 million euros on flat volume.',
          'Southern Europe declined 4 percent to 8.1 million euros, driven almost entirely by the loss of a single logistics contract in Portugal.',
        ],
      },
      {
        heading: 'Operating Expenses and Margin',
        paragraphs: [
          'Operating expenses rose to 31.4 million euros, of which personnel costs accounted for 19.2 million. Headcount grew by 46 to a total of 812 employees.',
          'Gross margin compressed by 130 basis points to 34.8 percent, reflecting higher freight rates on the Asia to Europe lane during August.',
          'Management expects margin recovery in the fourth quarter as the renegotiated freight contracts take effect from the first of November.',
        ],
      },
      {
        heading: 'Cash Position and Outlook',
        paragraphs: [
          'Cash and equivalents stood at 22.7 million euros at quarter end, against short-term borrowings of 6.3 million.',
          'The board reaffirmed full year guidance of between 190 and 196 million euros in revenue, with an adjusted operating margin of at least 12 percent.',
        ],
      },
    ],
    probes: {
      expected: [
        {
          question: 'Which region contributed the most revenue this quarter?',
          mustMatch: /Nordic|14\.6/i,
        },
        {
          question: 'What happened to the gross margin?',
          mustMatch: /34\.8|130 basis points/i,
        },
        { question: 'How much cash did the company hold at quarter end?', mustMatch: /22\.7/i },
      ],
      offTopic: [
        'How do I descale the boiler on my espresso machine?',
        'What is the recommended dosage of amoxicillin for a child?',
      ],
    },
  },

  {
    slug: 'clinical-trial-protocol',
    title: 'Protocol NW-227: Randomised Trial of Inhaled Budesonide',
    topic: 'clinical research',
    pages: [
      {
        heading: 'Study Design and Endpoints',
        paragraphs: [
          'This is a multicentre, double blind, placebo controlled trial enrolling 640 participants across eleven sites in four countries.',
          'The primary endpoint is the annualised rate of moderate to severe exacerbations over 52 weeks of treatment.',
          'Secondary endpoints include change from baseline in trough forced expiratory volume in one second, measured at weeks 12, 24 and 52.',
        ],
      },
      {
        heading: 'Eligibility Criteria',
        paragraphs: [
          'Participants must be between 40 and 80 years of age with a post bronchodilator ratio below 0.70 and a documented smoking history of at least ten pack years.',
          'Exclusion criteria include a diagnosis of asthma before the age of 40, any exacerbation requiring hospitalisation within six weeks of screening, and known hypersensitivity to corticosteroids.',
          'Participants receiving long term oral corticosteroids at a prednisolone equivalent dose above 10 milligrams daily are not eligible.',
        ],
      },
      {
        heading: 'Randomisation and Blinding',
        paragraphs: [
          'Eligible participants are randomised one to one to budesonide 320 micrograms twice daily or matched placebo, stratified by site and by exacerbation history.',
          'The randomisation schedule is held by an independent statistician. Unblinding is permitted only where knowledge of assignment would change acute clinical management.',
        ],
      },
    ],
    probes: {
      expected: [
        { question: 'What is the primary endpoint of the study?', mustMatch: /exacerbation/i },
        { question: 'What is the minimum age for enrolment?', mustMatch: /40/i },
        { question: 'How are participants randomised?', mustMatch: /one to one|stratified/i },
      ],
      offTopic: [
        'What was the operating margin last quarter?',
        'What pressure should the espresso pump be set to?',
      ],
    },
  },

  {
    slug: 'kubernetes-runbook',
    title: 'Platform Runbook — Ingress and Certificate Rotation',
    topic: 'infrastructure operations',
    pages: [
      {
        heading: 'Certificate Rotation',
        paragraphs: [
          'Wildcard certificates are issued by the internal ACME server and renewed automatically thirty days before expiry by cert-manager.',
          'If renewal fails, the Certificate resource reports a Ready condition of False with reason IssuerNotReady. Check that the ClusterIssuer secret has not been rotated out from under it.',
          'Manual renewal is triggered by deleting the CertificateRequest; cert-manager recreates it within one reconcile loop, typically under thirty seconds.',
        ],
      },
      {
        heading: 'Ingress Failure Modes',
        paragraphs: [
          'A 502 from the ingress controller with no matching entry in the application log almost always means the Service has no ready endpoints behind it.',
          'Confirm with kubectl get endpointslice. An empty address list points at a failing readiness probe rather than a networking fault.',
          'A 504 by contrast indicates the upstream accepted the connection but did not respond within the proxy read timeout, which defaults to sixty seconds.',
        ],
      },
      {
        heading: 'Rolling Restart Procedure',
        paragraphs: [
          'Restart a deployment with kubectl rollout restart, which respects the configured maxUnavailable and pod disruption budget.',
          'Never delete pods directly during an incident. Deleting bypasses the disruption budget and can take every replica down at once.',
        ],
      },
    ],
    probes: {
      expected: [
        {
          question: 'What does a 502 from the ingress controller usually mean?',
          mustMatch: /endpoints|readiness/i,
        },
        {
          question: 'How are TLS certificates renewed?',
          mustMatch: /cert-manager|thirty days/i,
        },
        {
          question: 'How should I restart a deployment safely?',
          mustMatch: /rollout restart|disruption budget/i,
        },
      ],
      offTopic: [
        'What is the exclusion criteria for the trial?',
        'How much revenue did the Nordic region generate?',
      ],
    },
  },
]);

/**
 * Edge cases the happy-path corpus does not cover.
 *
 * Each is a shape that has broken a real ingestion pipeline: a file with no
 * extractable text (a scan), one large enough to test the size ceiling, one
 * small enough to produce a single chunk, and one whose text is entirely
 * non-Latin.
 */
export const EDGE_CASES = Object.freeze({
  /** No text layer at all — parsing must fail cleanly, not produce empty chunks. */
  imageOnly: {
    slug: 'scanned-no-text-layer',
    title: 'Scanned Page Without Text Layer',
  },
  /** One short paragraph: exercises the single-chunk path. */
  tiny: {
    slug: 'single-paragraph',
    title: 'Single Paragraph',
    text: 'The mean time between failures for the replacement pump is rated at 4000 hours.',
  },
  /** Non-Latin script, to catch byte-vs-character length bugs in chunking. */
  unicode: {
    slug: 'unicode-content',
    title: 'Unicode Content',
    text: 'हिन्दी में लिखा गया एक परीक्षण दस्तावेज़। 日本語のテキストも含まれています。 Ελληνικά επίσης.',
  },
  /** Many pages of filler, to exercise batching and the page ceiling. */
  large: {
    slug: 'many-pages',
    title: 'Many Pages',
    pageCount: 120,
  },
});

/** @param {string} slug */
export function findCorpusDocument(slug) {
  return CORPUS.find((doc) => doc.slug === slug) ?? null;
}

/** Every expected probe across the corpus, tagged with its source document. */
export function allExpectedProbes() {
  return CORPUS.flatMap((doc) =>
    doc.probes.expected.map((probe) => ({ ...probe, slug: doc.slug, title: doc.title })),
  );
}

/** Every off-topic probe, tagged with the document it must *not* match. */
export function allOffTopicProbes() {
  return CORPUS.flatMap((doc) =>
    doc.probes.offTopic.map((question) => ({ question, slug: doc.slug })),
  );
}
