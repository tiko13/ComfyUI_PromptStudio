import { normalizeReferenceGrounding } from "../generation/reference-grounding.js";
import {
  CONSULT_RETENTION_MS,
  MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS,
  MAX_CONSULT_EXPERIMENT_PROMPT_CHARS,
  PROMPT_AGENT_DEFAULT_MAX_ITERATIONS,
  PROMPT_AGENT_MAX_CONTEXT_CHARS,
  PROMPT_AGENT_MAX_CONTEXT_MESSAGES,
  PROMPT_AGENT_MAX_ITERATIONS,
  PROMPT_AGENT_MAX_SAVED_ITERATIONS,
  PROMPT_AGENT_MIN_CONFIDENCE,
  PROMPT_AGENT_TARGET_SCORE,
} from "../core/constants.js";
import { makeId } from "../core/id.js";
import {
  normalizeGenerationLoraState,
  normalizeGenerationModelState,
  normalizeGenerationSnapshot,
} from "../chat/generation-state.js";
import { normalizeImageReference } from "../chat/image-reference.js";

export function normalizeConsultContext(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function normalizeConsultExperimentProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = String(value.prompt || "").trim();
  if (!prompt || prompt.length > MAX_CONSULT_EXPERIMENT_PROMPT_CHARS) return null;
  const styleGuidance = String(value.style_guidance ?? value.styleGuidance ?? "").trim();
  const framingGuidance = String(value.framing_guidance ?? value.framingGuidance ?? "").trim();
  if (
    styleGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
    || framingGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
  ) return null;
  const requestedAction = String(value.action || "propose").trim().toLowerCase();
  return {
    prompt,
    styleGuidance,
    framingGuidance,
    action: ["propose", "generate", "promote"].includes(requestedAction) ? requestedAction : "propose",
  };
}

export function normalizeConsultExperimentGeneration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    promptId: String(value.promptId || ""),
    generationState: ["queued", "generating", "complete", "error", "cancelled"].includes(value.generationState)
      ? value.generationState
      : "",
    text: String(value.text || ""),
    images: Array.isArray(value.images) ? value.images.map(normalizeImageReference).filter(Boolean) : [],
    mainPrompt: String(value.mainPrompt || ""),
    finalPrompt: String(value.finalPrompt || ""),
    executionPrompt: String(value.executionPrompt || value.finalPrompt || ""),
    generationAction: value.generationAction === "edit" ? "edit" : "create",
    workflowProfileId: String(value.workflowProfileId || ""),
    workflowName: String(value.workflowName || ""),
    loraState: normalizeGenerationLoraState(value.loraState),
    modelState: normalizeGenerationModelState(value.modelState),
    generationSnapshot: normalizeGenerationSnapshot(value.generationSnapshot),
    sourceImage: normalizeImageReference(value.sourceImage),
    referenceImage: normalizeImageReference(value.referenceImage),
    referenceGrounding: normalizeReferenceGrounding(value.referenceGrounding),
    resultNodeIds: Array.isArray(value.resultNodeIds) ? value.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(value.resultFields) && value.resultFields.length
      ? value.resultFields.map(String)
      : ["images", "gifs"],
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
}

export function normalizeConsultExperiment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.active !== true) return null;
  const startedAt = Number.isFinite(Number(value.startedAt)) ? Number(value.startedAt) : Date.now();
  const updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : startedAt;
  if (updatedAt < Date.now() - CONSULT_RETENTION_MS) return null;
  return {
    id: String(value.id || makeId()),
    active: true,
    baseMainPrompt: String(value.baseMainPrompt || ""),
    baseFinalPrompt: String(value.baseFinalPrompt || ""),
    stylePreset: String(value.stylePreset || "None"),
    stylePresetText: String(value.stylePresetText || ""),
    framingPreset: String(value.framingPreset || "None"),
    framingPresetText: String(value.framingPresetText || ""),
    candidatePrompt: String(value.candidatePrompt || ""),
    styleGuidance: String(value.styleGuidance || ""),
    framingGuidance: String(value.framingGuidance || ""),
    selectedMessageId: String(value.selectedMessageId || ""),
    startedAt,
    updatedAt,
  };
}

export function normalizePromptAgentRubric(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const criteria = Array.isArray(value.criteria)
    ? value.criteria.slice(0, 12).map((item, index) => ({
        id: String(item?.id || `criterion_${index + 1}`).slice(0, 80),
        description: String(item?.description || "").slice(0, 1000),
        weight: Math.max(0.1, Math.min(100, Number(item?.weight) || 1)),
        hard: item?.hard === true,
      })).filter((item) => item.description)
    : [];
  if (!criteria.length) return null;
  return {
    summary: String(value.summary || "").slice(0, 4000),
    reference_notes: Array.isArray(value.reference_notes)
      ? value.reference_notes.slice(0, 4).map((item, index) => ({
          label: String(item?.label || `Reference ${index + 1}`).slice(0, 80),
          purpose: String(item?.purpose || "general reference").slice(0, 200),
          visible_content: String(item?.visible_content || "").slice(0, 4000),
          apply: String(item?.apply || "").slice(0, 2000),
        })).filter((item) => item.visible_content && item.apply)
      : [],
    criteria,
    forbidden: Array.isArray(value.forbidden)
      ? value.forbidden.map((item) => String(item || "").slice(0, 1000)).filter(Boolean).slice(0, 12)
      : [],
  };
}

export function normalizePromptAgentCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = String(value.prompt || "").trim();
  if (!prompt || prompt.length > MAX_CONSULT_EXPERIMENT_PROMPT_CHARS) return null;
  const styleGuidance = String(value.style_guidance ?? value.styleGuidance ?? "").trim();
  const framingGuidance = String(value.framing_guidance ?? value.framingGuidance ?? "").trim();
  if (
    styleGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
    || framingGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
  ) return null;
  return {
    prompt,
    styleGuidance,
    framingGuidance,
    changeSummary: String(value.change_summary ?? value.changeSummary ?? "").slice(0, 4000),
  };
}

export function normalizePromptAgentEvaluation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    score: Math.max(0, Math.min(100, Number(value.score) || 0)),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    pass: value.pass === true,
    criteria: Array.isArray(value.criteria)
      ? value.criteria.slice(0, 12).map((item) => ({
          id: String(item?.id || "").slice(0, 80),
          status: ["pass", "partial", "fail"].includes(item?.status) ? item.status : "fail",
          score: Math.max(0, Math.min(100, Number(item?.score) || 0)),
          evidence: String(item?.evidence || "").slice(0, 2000),
          referenceEvidence: String(item?.reference_evidence ?? item?.referenceEvidence ?? "").slice(0, 2000),
        })).filter((item) => item.id)
      : [],
    forbidden: Array.isArray(value.forbidden)
      ? value.forbidden.slice(0, 12).map((item, index) => ({
          index: Math.max(1, Math.trunc(Number(item?.index) || index + 1)),
          outcome: String(item?.outcome || "").slice(0, 1000),
          status: ["clear", "visible", "uncertain"].includes(item?.status)
            ? item.status
            : "uncertain",
          evidence: String(item?.evidence || "").slice(0, 2000),
          referenceEvidence: String(item?.reference_evidence ?? item?.referenceEvidence ?? "").slice(0, 2000),
        })).filter((item) => item.outcome)
      : [],
    defects: Array.isArray(value.defects)
      ? value.defects.map((item) => String(item || "").slice(0, 1000)).filter(Boolean).slice(0, 12)
      : [],
    nextRevision: String(value.next_revision ?? value.nextRevision ?? "").slice(0, 4000),
    summary: String(value.summary || "").slice(0, 4000),
    referenceComparison: value.reference_comparison || value.referenceComparison || null,
    metrics: normalizePromptAgentMetrics(value.metrics),
  };
}

export function normalizePromptAgentIteration(value, fallbackIndex = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const createdAt = Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now();
  return {
    id: String(value.id || makeId()),
    index: Math.max(1, Math.trunc(Number(value.index) || fallbackIndex + 1)),
    status: ["architecting", "generating", "evaluating", "complete", "stopped", "error"].includes(value.status)
      ? value.status
      : "architecting",
    candidate: normalizePromptAgentCandidate(value.candidate),
    generation: normalizeConsultExperimentGeneration(value.generation),
    evaluation: normalizePromptAgentEvaluation(value.evaluation),
    validation: value.validation === true,
    createdAt,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : createdAt,
  };
}

export function normalizePromptAgentConversationContext(value) {
  if (!Array.isArray(value)) return [];
  const normalized = value.slice(-PROMPT_AGENT_MAX_CONTEXT_MESSAGES).map((message) => ({
    role: message?.role === "assistant" ? "assistant" : "user",
    text: String(message?.text || "").trim().slice(0, 8000),
    context: normalizeConsultContext(message?.context),
  })).filter((message) => message.text || message.context);
  const selected = [];
  let remaining = PROMPT_AGENT_MAX_CONTEXT_CHARS;
  for (let index = normalized.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = normalized[index];
    const contextText = message.context ? JSON.stringify(message.context) : "";
    const fixedCost = contextText.length + 32;
    if (fixedCost >= remaining) continue;
    const text = message.text.slice(-Math.max(0, remaining - fixedCost));
    selected.unshift({ ...message, text });
    remaining -= fixedCost + text.length;
  }
  return selected;
}

export function normalizeConsultAgent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const goal = String(value.goal || "").trim();
  if (!goal) return null;
  const startedAt = Number.isFinite(Number(value.startedAt)) ? Number(value.startedAt) : Date.now();
  const updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : startedAt;
  if (updatedAt < Date.now() - CONSULT_RETENTION_MS) return null;
  const status = [
    "compiling", "architecting", "generating", "evaluating", "validating",
    "paused", "complete", "stopped", "error",
  ].includes(value.status) ? value.status : "paused";
  return {
    id: String(value.id || makeId()),
    requestId: String(value.requestId || "").slice(0, 128),
    requestPhase: ["compile", "architect", "evaluate"].includes(value.requestPhase) ? value.requestPhase : "",
    active: value.active === true && !["complete", "stopped", "error"].includes(status),
    status,
    resumeStatus: [
      "compiling", "architecting", "generating", "evaluating", "validating",
    ].includes(value.resumeStatus) ? value.resumeStatus : "",
    goal,
    conversationContext: normalizePromptAgentConversationContext(value.conversationContext),
    references: Array.isArray(value.references)
      ? value.references.slice(0, 4).map((item) => ({
          image: normalizeImageReference(item?.image),
          purpose: String(item?.purpose || "general reference").slice(0, 200),
        })).filter((item) => item.image)
      : [],
    rubric: normalizePromptAgentRubric(value.rubric),
    initialStyle: {
      name: String(value.initialStyle?.name || "None"),
      instruction: String(value.initialStyle?.instruction || "").slice(0, MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS),
    },
    initialFraming: {
      name: String(value.initialFraming?.name || "None"),
      instruction: String(value.initialFraming?.instruction || "").slice(0, MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS),
    },
    feedback: Array.isArray(value.feedback)
      ? value.feedback.map((item) => ({
          text: String(item?.text || "").trim().slice(0, 4000),
          createdAt: Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : updatedAt,
        })).filter((item) => item.text)
      : [],
    iterations: Array.isArray(value.iterations)
      ? value.iterations.map(normalizePromptAgentIteration).filter(Boolean)
      : [],
    currentIterationId: String(value.currentIterationId || ""),
    bestIterationId: String(value.bestIterationId || ""),
    maxIterations: Math.max(
      1,
      Math.min(PROMPT_AGENT_MAX_ITERATIONS, Math.trunc(Number(value.maxIterations) || PROMPT_AGENT_DEFAULT_MAX_ITERATIONS)),
    ),
    cycleStartIndex: Math.max(1, Math.trunc(Number(value.cycleStartIndex) || 1)),
    targetScore: Math.max(1, Math.min(100, Number(value.targetScore) || PROMPT_AGENT_TARGET_SCORE)),
    minConfidence: Math.max(0, Math.min(1, Number(value.minConfidence) || PROMPT_AGENT_MIN_CONFIDENCE)),
    validationRequired: value.validationRequired !== false,
    referenceComparison: value.referenceComparison === true,
    phaseMetrics: Array.isArray(value.phaseMetrics) ? value.phaseMetrics.map(item=>({...normalizePromptAgentMetrics(item),requestId:String(item?.requestId||''),phase:String(item?.phase||'')})).filter(item=>item.version===1&&item.requestId) : [],
    error: String(value.error || "").slice(0, 4000),
    startedAt,
    updatedAt,
  };
}

export function normalizeConsultMessage(message) {
  const id = String(message?.id || makeId());
  const role = message?.role === "assistant" ? "assistant" : "user";
  const createdAt = Number(message?.createdAt);
  const updatedAt = Number(message?.updatedAt);
  const normalizedCreatedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
  const normalizedUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : normalizedCreatedAt;
  const normalized = {
    id,
    role,
    text: String(message?.text || ""),
    context: normalizeConsultContext(message?.context),
    images: Array.isArray(message?.images)
      ? message.images.map(normalizeImageReference).filter(Boolean).slice(0, 4)
      : [],
    experimentId: String(message?.experimentId || ""),
    requestFailed: message?.requestFailed === true,
    createdAt: normalizedCreatedAt,
    updatedAt: normalizedUpdatedAt,
  };
  if (role !== "assistant") return normalized;

  const variants = Array.isArray(message?.variants)
    ? message.variants
        .filter((variant) => variant && typeof variant === "object")
        .map((variant, index) => ({
          id: String(variant.id || `${id}-response-${index}`),
          text: String(variant.text || ""),
          proposal: normalizeConsultExperimentProposal(variant.proposal),
          generation: normalizeConsultExperimentGeneration(variant.generation),
          requestFailed: variant.requestFailed === true,
          createdAt: Number.isFinite(Number(variant.createdAt))
            ? Number(variant.createdAt)
            : normalizedCreatedAt,
        }))
        .filter((variant) => variant.text.trim())
    : [];
  if (!variants.length && normalized.text.trim()) {
    variants.push({
      id: `${id}-response-0`,
      text: normalized.text,
      proposal: normalizeConsultExperimentProposal(message?.proposal),
      generation: normalizeConsultExperimentGeneration(message?.generation),
      requestFailed: normalized.requestFailed,
      createdAt: normalizedCreatedAt,
    });
  }
  const requestedIndex = Number(message?.variantIndex);
  const variantIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(Math.trunc(requestedIndex), variants.length - 1))
    : Math.max(0, variants.length - 1);
  return {
    ...normalized,
    text: variants[variantIndex]?.text || normalized.text,
    proposal: variants[variantIndex]?.proposal || null,
    generation: variants[variantIndex]?.generation || null,
    requestFailed: variants[variantIndex]?.requestFailed === true,
    variants,
    variantIndex,
  };
}

export function retainedConsultMessages(messages, now = Date.now()) {
  const cutoff = now - CONSULT_RETENTION_MS;
  const retained = messages.filter((message) => {
    const timestampMs = consultTimestampMs(message.createdAt);
    return Number.isFinite(timestampMs) && timestampMs >= cutoff;
  });
  return retained;
}

export function consultTimestampMs(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return NaN;
  return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
}

export function consultMessagesAfterClear(messages, clearedAt) {
  const cutoff = consultTimestampMs(clearedAt);
  if (!Number.isFinite(cutoff) || cutoff <= 0) return messages;
  return messages.filter((message) => consultTimestampMs(message.createdAt) >= cutoff);
}

export function normalizePromptAgentMetrics(value) {
  if(!value||value.version!==1)return null;
  const calls=Number(value.model_calls),elapsed=Number(value.elapsed_ms);
  if(!Number.isInteger(calls)||calls<0||!Number.isFinite(elapsed)||elapsed<0)return null;
  return {version:1,model_calls:calls,elapsed_ms:elapsed,reference_comparison:value.reference_comparison===true,calibration_measured:value.calibration_measured===true};
}

/** Stable candidate IDs resolve exact ties independently of array/display order. */
export function rankPromptAgentIterations(iterations) {
  return [...iterations].filter(item=>item.evaluation).sort((left,right)=>
    Number(right.evaluation.pass===true)-Number(left.evaluation.pass===true)
    || Number(right.evaluation.score||0)-Number(left.evaluation.score||0)
    || Number(right.evaluation.confidence||0)-Number(left.evaluation.confidence||0)
    || String(left.id).localeCompare(String(right.id)));
}

export function repeatedPromptAgentDefects(iterations,count=3) {
  const recent=iterations.filter(item=>item.evaluation&&!item.validation).slice(-count);
  if(recent.length<count)return [];
  const key=value=>String(value).trim().toLocaleLowerCase().replace(/\s+/g,' ');
  const remaining=recent.slice(1).map(item=>new Set((item.evaluation.defects||[]).map(key)));
  return (recent[0].evaluation.defects||[]).filter(value=>remaining.every(set=>set.has(key(value))));
}

export function explainPromptAgentWinner(iterations) {
  const [best,next]=rankPromptAgentIterations(iterations);
  if(!best)return 'No candidate has a visual evaluation yet.';
  const evaluation=best.evaluation;
  const basis=evaluation.pass?'passed the required visual checks':'is the highest-ranked available result; required checks have not all passed';
  const tie=next&&evaluation.pass===next.evaluation.pass&&evaluation.score===next.evaluation.score&&evaluation.confidence===next.evaluation.confidence?' Exact ties use the stable candidate ID.':'';
  return `Candidate ${best.index??best.id} ${basis}, with score ${Math.round(evaluation.score)} and confidence ${Math.round(evaluation.confidence*100)}%.${tie}`;
}
