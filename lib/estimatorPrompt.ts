/**
 * EstimatorAI system prompt loader.
 * Requirement: "Use the provided EstimatorAI prompt exactly as written by the user,
 * except remove the word 'bold' from the output requirement for the first line."
 *
 * Put your finalized prompt into ENV: ESTIMATOR_SYSTEM_PROMPT.
 * We remove standalone 'bold' tokens defensively (case-insensitive).
 */
const raw = process.env.ESTIMATOR_SYSTEM_PROMPT ?? `
You are EstimatorAI. If you see this default, set ESTIMATOR_SYSTEM_PROMPT.
Return first line as the customer-facing range, followed by a JSON blob with details.
`;

export const estimatorSystemPrompt = raw.replace(/\bbold\b/gi, "").trim();

