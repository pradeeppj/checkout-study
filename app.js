/*************************************************
 * Gift Card Checkout Study
 * - Single Firestore write ONLY after SURVEY submit (no PII)
 * - Tracks step transitions + dwell time locally
 * - Physical/Digital branching
 * - 1 recipient only (no "number of recipients" field shown)
 * - Recipient is split into subpages: qty -> amount -> message
 * - Condition A: Standard only
 * - Condition B: Standard / Voice / Chat (user-selectable per step)
 *              - When Voice/Chat is selected, clicking/manual controls are disabled
 * - Condition C: Agent-selected modality per step (hardcoded, locked)
 *              - Manual controls disabled unless locked modality is "standard"
 *
 * Fixes in this version:
 * - Digital flow: REMOVED Packaging step (doesn't show for Digital)
 * - Continue gating: qty defaults to 1 and amount defaults to 50, so Continue stays enabled
 * - Pricing: shows "—" until required pricing inputs are selected; pricing never decreases (no negative deltas)
 *************************************************/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/***********************
 * Firebase (write once)
 ***********************/
const firebaseConfig = {
  apiKey: "AIzaSyCiKsbuQ_HGwgD9yrL5V5CG3tmv1JY1-R8",
  authDomain: "giftcard-checkout-study.firebaseapp.com",
  projectId: "giftcard-checkout-study",
  storageBucket: "giftcard-checkout-study.firebasestorage.app",
  messagingSenderId: "665774262534",
  appId: "1:665774262534:web:aa71cb270e1f2e6e1e3687",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function writeFinal(payload) {
  try {
    await addDoc(collection(db, "study_events"), {
      type: "study_completed",
      payload,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Firestore final write failed:", err);
    setText("surveyStatus", "Upload failed. Please try again.");
  }
}

/***********************
 * Condition selection (A/B/C)
 * - Accepts URL ?cond=A|B|C (also condition=, c=)
 * - If missing, assigns once, stores in localStorage, AND writes to URL
 ***********************/
const CONDITION_KEY = "study_condition_abc";
let CONDITION = null;

/**
 * Returns cached condition if already assigned on this device.
 * Otherwise reads Firestore completion counts and assigns the least-filled condition.
 * NO URL params used.
 */
/***********************
 * Condition selection (A/B/C)
 * Accepts:
 *   - Query param: ?cond=A|B|C   (also ?condition=, ?c=)
 *   - Hash:        #A | #B | #C
 *
 * Behavior:
 *   - If URL provides a condition, it overrides localStorage
 *   - After reading it, we REMOVE it from the URL (no visible params)
 *   - Otherwise we reuse localStorage
 *   - Otherwise default to A
 ***********************/
function getCondition() {
  const key = "study_condition_abc";
  const url = new URL(window.location.href);

  // 1) Query param (supports ?cond=, ?condition=, ?c=)
  const qp =
    (url.searchParams.get("cond") ||
      url.searchParams.get("condition") ||
      url.searchParams.get("c") ||
      "")
      .toUpperCase()
      .trim();

  // 2) Hash (#A/#B/#C)
  const h = (url.hash || "").replace("#", "").toUpperCase().trim();

  const fromUrl = (qp === "A" || qp === "B" || qp === "C") ? qp
                : (h === "A" || h === "B" || h === "C") ? h
                : "";

  if (fromUrl) {
    // Persist assignment
    localStorage.setItem(key, fromUrl);

    // Remove URL condition traces (query + hash)
    url.searchParams.delete("cond");
    url.searchParams.delete("condition");
    url.searchParams.delete("c");
    url.hash = "";
    history.replaceState({}, "", url.toString());

    return fromUrl;
  }

  // Reuse prior assignment
  const existing = (localStorage.getItem(key) || "").toUpperCase();
  if (existing === "A" || existing === "B" || existing === "C") return existing;

  // Default
  const fallback = "A";
  localStorage.setItem(key, fallback);
  return fallback;
}

const CONDITION = getCondition();

/***********************
 * Local session state
 ***********************/
let currentStep = 0;
let stepEnteredAt = null;

const answers = {};
const session = {
  condition: CONDITION,
  startedAt: null,
  checkoutCompletedAt: null,
  surveySubmittedAt: null,
  taskDurationMs: null,
  transitions: [],
  answers: {},
  input_method_by_step: {},
  survey: {},
};

let currentInputMethod = "standard"; // B user-controlled; C locked per-step

/***********************
 * Condition C: hardcoded modality maps (no variability)
 * NOTE: Digital flow has NO packaging step.
 ***********************/
const CONDITION_C_MAP_PHYSICAL = {
  card_type: "voice",
  variant: "voice",
  expiry: "chat",
  design: "standard",
  activation: "voice",
  packaging: "chat",
  r1_qty: "voice",
  r1_amt: "chat",
  r1_msg: "chat",
  shipping_method: "voice",
  shipping_address: "chat",
  payment: "standard",
};

const CONDITION_C_MAP_DIGITAL = {
  card_type: "voice",
  variant: "chat",
  expiry: "standard",
  design: "standard",
  activation: "voice",
  r1_qty: "chat",
  r1_amt: "voice",
  r1_msg: "chat",
  digital_delivery: "voice",
  digital_identifier: "standard",
  payment: "chat",
};

function getConditionCMap() {
  // Before selection, default to DIGITAL mapping so the UI is deterministic.
  return answers.card_type === "Physical" ? CONDITION_C_MAP_PHYSICAL : CONDITION_C_MAP_DIGITAL;
}

function resolveInputMethodForStep(stepId) {
  if (CONDITION === "C") {
    const map = getConditionCMap();
    return map?.[stepId] || "standard";
  }
  return currentInputMethod || "standard";
}

/***********************
 * Manual interaction policy
 * - A: always allowed
 * - B: allowed ONLY when currentInputMethod === "standard"
 * - C: allowed ONLY when locked modality === "standard"
 ***********************/
function isManualInputAllowedForCurrentStep(stepObj) {
  if (!stepObj) return true;
  if (CONDITION === "A") return true;

  if (CONDITION === "B") {
    return (currentInputMethod || "standard") === "standard";
  }

  // CONDITION === "C"
  return (currentInputMethod || "standard") === "standard";
}

/***********************
 * Design library
 ***********************/
const CARD_DESIGNS = [
  { id: "balloons", label: "Bright Balloons", style: "bg-balloons", category: "Celebration" },
  { id: "confetti", label: "Confetti Pop", style: "bg-confetti", category: "Celebration" },
  { id: "birthday", label: "Birthday Cake", style: "bg-birthday", category: "Celebration" },
  { id: "love", label: "Love Notes", style: "bg-love", category: "Greetings" },
  { id: "thanks", label: "Thank You", style: "bg-thanks", category: "Appreciation" },
  { id: "holiday", label: "Holiday Cheer", style: "bg-holiday", category: "Seasonal" },
  { id: "gold", label: "Golden Luxe", style: "bg-gold", category: "Luxury" },
  { id: "black", label: "Matte Black", style: "bg-black", category: "Luxury" },
  { id: "classic", label: "Classic Red", style: "bg-classic", category: "Classic" },
  { id: "neon", label: "Neon Night", style: "bg-neon", category: "Modern" },
  { id: "pastel", label: "Soft Pastels", style: "bg-pastel", category: "Any Occasion" },
  { id: "minimal1", label: "Minimal Light", style: "bg-minimal-1", category: "Minimal" },
  { id: "minimal2", label: "Minimal Dark", style: "bg-minimal-2", category: "Minimal" },
  { id: "fun1", label: "Smile Waves", style: "bg-fun-1", category: "Fun" },
  { id: "fun2", label: "Fresh Mint", style: "bg-fun-2", category: "Fun" },
  { id: "nature1", label: "Green Calm", style: "bg-nature-1", category: "Nature" },
  { id: "nature2", label: "Ocean Blue", style: "bg-nature-2", category: "Nature" },
  { id: "abs1", label: "Abstract Flow", style: "bg-abs-1", category: "Abstract" },
  { id: "abs2", label: "Abstract Bold", style: "bg-abs-2", category: "Abstract" },
  { id: "skyline", label: "City Skyline", style: "bg-skyline", category: "Modern" },
  { id: "lavender", label: "Lavender Haze", style: "bg-lavender", category: "Any Occasion" },
  { id: "sand", label: "Sunny Sand", style: "bg-sand", category: "Seasonal" },
  { id: "mint", label: "Mint Glow", style: "bg-mint", category: "Modern" },
  { id: "kids", label: "Kids Party", style: "bg-kids", category: "Kids" },
];

/***********************
 * Step model
 ***********************/
function step({ id, title, required = true, kind = "choice", options = null, render }) {
  return { id, title, required, kind, options, render };
}

/***********************
 * 1-recipient defaults
 * (Important for Continue gating: qty=1, amt=50)
 ***********************/
function ensureRecipient1Defaults() {
  if (!answers.r1_qty) setAnswer("r1_qty", "1");
  if (!answers.r1_amt) setAnswer("r1_amt", "50");
  if (answers.r1_msg === undefined) setAnswer("r1_msg", "");
}

function ensureDesignDefaults() {
  if (!answers.design_category) setAnswer("design_category", "All");
  if (!answers.design) setAnswer("design", "confetti");
}

/***********************
 * Steps
 * NOTE: Packaging only exists in PHYSICAL flow now.
 ***********************/
const baseSteps = [
  step({
    id: "card_type",
    title: "Select Card Type",
    kind: "choice",
    options: ["Physical", "Digital"],
    render: (s) => stepShell(s, optionsGrid("card_type", ["Physical", "Digital"])),
  }),
  step({
    id: "variant",
    title: "Card Variant",
    kind: "choice",
    options: ["Reloadable", "Non-reloadable"],
    render: (s) => stepShell(s, optionsGrid("variant", ["Reloadable", "Non-reloadable"])),
  }),
  step({
    id: "expiry",
    title: "Expiry & Pricing",
    kind: "choice",
    options: ["No expiry (higher price)", "6-month expiry", "12-month expiry"],
    render: (s) => stepShell(s, optionsGrid("expiry", ["No expiry (higher price)", "6-month expiry", "12-month expiry"])),
  }),
  step({
    id: "design",
    title: "Choose a Design",
    kind: "design",
    options: CARD_DESIGNS.map((d) => d.label),
    render: (s) => stepShell(s, designPicker()),
  }),
  step({
    id: "activation",
    title: "Delivery & Activation",
    kind: "choice",
    options: [
      "Same activation for all cards",
      "Unique activation per card",
      "Bulk activation by sender",
      "Activation via card number",
    ],
    render: (s) =>
      stepShell(
        s,
        optionsGrid("activation", [
          "Same activation for all cards",
          "Unique activation per card",
          "Bulk activation by sender",
          "Activation via card number",
        ])
      ),
  }),

  // Recipient subpages (Recipient 1 only)
  step({
    id: "r1_qty",
    title: "Recipient: Quantity",
    kind: "number",
    required: true,
    render: (s) => stepShell(s, recipientQtyField()),
  }),
  step({
    id: "r1_amt",
    title: "Recipient: Gift amount",
    kind: "amount",
    required: true,
    render: (s) => stepShell(s, recipientAmountField()),
  }),
  step({
    id: "r1_msg",
    title: "Recipient: Gift message (optional)",
    kind: "text",
    required: false,
    render: (s) => stepShell(s, recipientMsgField()),
  }),
];

function getConditionalSteps() {
  const type = answers.card_type;

  if (type === "Digital") {
    return [
      step({
        id: "digital_delivery",
        title: "Digital Delivery Method",
        kind: "choice",
        options: ["Email", "SMS"],
        render: (s) => stepShell(s, optionsGrid("digital_delivery", ["Email", "SMS"])),
      }),
      step({
        id: "digital_identifier",
        title: "Delivery Identifier",
        kind: "info",
        required: false,
        render: (s) =>
          stepShell(
            s,
            displayBlock(
              "A synthetic identifier will be used.",
              answers.digital_delivery === "SMS" ? "+1 555-010-0001" : "recipient@test.delivery"
            )
          ),
      }),
    ];
  }

  // Default to Physical branch if not decided yet (so the flow is stable when starting)
  return [
    step({
      id: "packaging",
      title: "Packaging",
      kind: "choice",
      options: ["Greeting card", "Trifold printed paper", "Box packaging"],
      render: (s) => stepShell(s, optionsGrid("packaging", ["Greeting card", "Trifold printed paper", "Box packaging"])),
    }),
    step({
      id: "shipping_method",
      title: "Shipping Method",
      kind: "choice",
      options: ["Standard shipping", "Expedited shipping"],
      render: (s) => stepShell(s, optionsGrid("shipping_method", ["Standard shipping", "Expedited shipping"])),
    }),
    step({
      id: "shipping_address",
      title: "Shipping Address",
      kind: "info",
      required: false,
      render: (s) => stepShell(s, displayBlock("This is a fictional address.", "123 Market St\nSpringfield, CA 99999")),
    }),
  ];
}

const paymentStep = step({
  id: "payment",
  title: "Payment Method",
  kind: "choice",
  options: ["Test Credit Card (4242)", "Test Debit Card (1111)"],
  render: (s) => stepShell(s, optionsGrid("payment", ["Test Credit Card (4242)", "Test Debit Card (1111)"])),
});

function computeFlow() {
  return [...baseSteps, ...getConditionalSteps(), paymentStep];
}

/***********************
 * Step shell
 * - B: chooser + pane
 * - C: locked pane only
 * - A: none
 ***********************/
function stepShell(stepObj, innerHtml) {
  if (CONDITION === "B") {
    return `${renderInputMethod(stepObj)}${innerHtml}`;
  }

  if (CONDITION === "C") {
    const hint = inputHintForStep(stepObj);
    return `
      <div class="card" style="padding:14px;margin-bottom:14px;">
        <div style="font-weight:1000;margin-bottom:6px;">Input method</div>
        <div class="muted small" style="margin-bottom:10px;">
          The system has selected an input method for this step.
        </div>
        <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
          ${renderInputPane(stepObj, hint)}
        </div>
      </div>
      ${innerHtml}
    `;
  }

  return innerHtml;
}

function renderInputMethod(stepObj) {
  const cur = currentInputMethod || "standard";
  const hint = inputHintForStep(stepObj);

  return `
    <div class="card" style="padding:14px;margin-bottom:14px;">
      <div style="font-weight:1000;margin-bottom:6px;">Input method</div>
      <div class="muted small" style="margin-bottom:10px;">
        Choose how you want to enter information. You can switch at any time.
      </div>

      <div class="optionGrid" style="grid-template-columns:repeat(3,minmax(0,1fr));">
        <div class="optionCard ${cur === "standard" ? "selected" : ""}" role="button" tabindex="0" data-im="standard">
          <div style="font-weight:1000;font-size:18px;">Standard</div>
          <div class="muted small">Click / type</div>
        </div>
        <div class="optionCard ${cur === "voice" ? "selected" : ""}" role="button" tabindex="0" data-im="voice">
          <div style="font-weight:1000;font-size:18px;">Voice</div>
          <div class="muted small">Speak</div>
        </div>
        <div class="optionCard ${cur === "chat" ? "selected" : ""}" role="button" tabindex="0" data-im="chat">
          <div style="font-weight:1000;font-size:18px;">Chat</div>
          <div class="muted small">Type message</div>
        </div>
      </div>

      <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
        ${renderInputPane(stepObj, hint)}
      </div>
    </div>
  `;
}

function renderInputPane(stepObj, hint) {
  if (currentInputMethod === "voice") {
    return `
      <div class="muted small" style="margin-bottom:10px;">${escapeHtml(hint)}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <button class="btn btnPrimary" id="voiceStartBtn" type="button">Start voice</button>
        <button class="btn btnGhost" id="voiceStopBtn" type="button" disabled>Stop</button>
      </div>
      <div class="card" style="padding:12px;margin-top:10px;">
        <div id="voiceTranscript" class="muted small">Tap “Start voice” and speak.</div>
      </div>
    `;
  }

  if (currentInputMethod === "chat") {
    return `
      <div class="muted small" style="margin-bottom:10px;">${escapeHtml(hint)}</div>
      <div style="display:flex;gap:10px;align-items:center;">
        <input id="chatInput" type="text" placeholder='Type your answer (e.g., "Digital", "5", "$50")' />
        <button class="btn btnPrimary" id="chatSendBtn" type="button">Send</button>
      </div>
      <div class="card" style="padding:12px;margin-top:10px;">
        <div id="chatLog" class="muted small">Chat applies your message to the current step.</div>
      </div>
    `;
  }

  return `<div class="muted small">Use the on-screen controls to make your selections.</div>`;
}

/***********************
 * Condition-aware hint text (B vs C)
 ***********************/
function inputHintForStep(stepObj) {
  const m = currentInputMethod || "standard";

  // Condition B: can be voice or chat, but user can choose; guide with "Say or type"
  if (CONDITION === "B") {
    const verb = (m === "voice") ? "Say" : (m === "chat") ? "Type" : "Use";
    switch (stepObj.kind) {
      case "choice": return `${verb} one of the visible options.`;
      case "design": return `${verb} a design name (e.g., "Confetti Pop").`;
      case "number": return `${verb} a number (e.g., "five", "5").`;
      case "amount": return `${verb} an amount (e.g., "50", "$75").`;
      case "text": return `${verb} a short message (avoid personal info).`;
      default: return `${verb} your answer.`;
    }
  }

  // Condition C: system-selected; guide based on locked modality
  if (CONDITION === "C") {
    const verb = (m === "voice") ? "Say" : (m === "chat") ? "Type" : "Use";
    switch (stepObj.kind) {
      case "choice": return `${verb} one of the visible options.`;
      case "design": return `${verb} a design name (e.g., "Confetti Pop").`;
      case "number": return `${verb} a number (e.g., "five", "5").`;
      case "amount": return `${verb} an amount (e.g., "50", "$75").`;
      case "text": return `${verb} a short message (avoid personal info).`;
      default: return `${verb} your answer.`;
    }
  }

  // Condition A
  switch (stepObj.kind) {
    case "choice": return "Select one of the visible options.";
    case "design": return "Select a design.";
    case "number": return "Enter a number.";
    case "amount": return "Enter an amount.";
    case "text": return "Enter a short message (avoid personal info).";
    default: return "Continue.";
  }
}

/***********************
 * Render step
 ***********************/
function renderStep() {
  const flow = computeFlow();

  if (currentStep >= flow.length) {
    session.checkoutCompletedAt = Date.now();
    session.taskDurationMs = session.checkoutCompletedAt - session.startedAt;

    showScreen("surveyScreen");
    renderSurvey();
    return;
  }

  const stepObj = flow[currentStep];

  // Always ensure defaults exist (prevents Continue from disabling on qty/amount)
  ensureRecipient1Defaults();
  ensureDesignDefaults();

  // Condition C: lock modality per step deterministically
  if (CONDITION === "C") {
    currentInputMethod = resolveInputMethodForStep(stepObj.id);
    session.input_method_by_step[stepObj.id] = currentInputMethod;
  } else if (CONDITION === "A") {
    currentInputMethod = "standard";
  } else {
    // Condition B: session records whenever user switches; keep current as-is
    session.input_method_by_step[stepObj.id] = currentInputMethod || "standard";
  }

  stepEnteredAt = Date.now();

  setText("progress", `Step ${currentStep + 1} of ${flow.length}: ${stepObj.title}`);
  document.getElementById("stepContainer").innerHTML = stepObj.render(stepObj);
  document.getElementById("backBtn").disabled = currentStep === 0;

  wireStepInteractions(stepObj);
  refreshPreview();
  updateNextButtonState(stepObj);
}

/***********************
 * Next button gating
 ***********************/
function isStepComplete(stepObj) {
  if (!stepObj.required) return true;

  if (stepObj.kind === "design") return !!answers.design;

  const v = answers[stepObj.id];

  if (stepObj.kind === "choice") return !!v;

  if (stepObj.kind === "number") return Number(answers.r1_qty) >= 1;

  if (stepObj.kind === "amount") return Number(answers.r1_amt) >= 5;

  return true;
}

function updateNextButtonState(stepObj) {
  const nextBtn = document.getElementById("nextBtn");
  if (!nextBtn || !stepObj) return;
  nextBtn.disabled = !isStepComplete(stepObj);
}

/***********************
 * Survey rendering
 ***********************/
function renderSurvey() {
  const c = document.getElementById("surveyContainer");
  if (!c) return;

  c.innerHTML = `
    ${surveySection("NASA-TLX (0–20)", [
      tlxSlider("Mental demand", "tlx_mental"),
      tlxSlider("Physical demand", "tlx_physical"),
      tlxSlider("Temporal demand", "tlx_temporal"),
      tlxSlider("Performance (higher = worse)", "tlx_performance"),
      tlxSlider("Effort", "tlx_effort"),
      tlxSlider("Frustration", "tlx_frustration"),
    ])}

    ${surveySection("Usability (UMUX-Lite, 1–7)", [
      likert7("This system’s capabilities meet my requirements.", "umux_req"),
      likert7("This system is easy to use.", "umux_easy"),
    ])}

    ${surveySection("Trust, control, effort, satisfaction (1–7)", [
      likert7("How effortful was this checkout experience?", "peffort"),
      likert7("I trust the system to complete the checkout correctly.", "trust"),
      likert7("I felt in control of what information was submitted.", "control"),
      likert7("Overall, I am satisfied with this checkout experience.", "satisfaction"),
    ])}
  `;

  const btn = document.getElementById("surveySubmitBtn");
  btn.onclick = onSubmitSurvey;

  document.querySelectorAll("[data-tlx]").forEach((el) => {
    el.addEventListener("input", () => {
      const id = el.getAttribute("data-tlx");
      const label = document.getElementById(`${id}_val`);
      if (label) label.textContent = String(el.value);
    });
  });
}

function surveySection(title, itemsHtml) {
  return `
    <div class="surveySection">
      <h3>${escapeHtml(title)}</h3>
      ${itemsHtml.join("")}
    </div>
  `;
}

function tlxSlider(label, id) {
  const v = Number(session.survey[id] ?? 10);
  return `
    <div class="surveyItem">
      <div class="q">${escapeHtml(label)} <span class="muted small">(0–20)</span></div>
      <input type="range" min="0" max="20" step="1" value="${v}" data-tlx="${escapeAttr(id)}" />
      <div class="scaleLabels">
        <span>Very Low</span>
        <strong id="${escapeAttr(id)}_val">${v}</strong>
        <span>Very High</span>
      </div>
    </div>
  `;
}

function likert7(prompt, id) {
  const sel = String(session.survey[id] ?? "");
  const opts = [1, 2, 3, 4, 5, 6, 7]
    .map(
      (v) => `
    <label class="radioPill">
      <input type="radio" name="${escapeAttr(id)}" value="${v}" ${sel === String(v) ? "checked" : ""}>
      <span>${v}</span>
    </label>
  `
    )
    .join("");

  return `
    <div class="surveyItem">
      <div class="q">${escapeHtml(prompt)} <span class="muted small">(1–7)</span></div>
      <div class="radioRow">${opts}</div>
    </div>
  `;
}

function collectSurvey() {
  const out = {};

  document.querySelectorAll("[data-tlx]").forEach((el) => {
    const k = el.getAttribute("data-tlx");
    out[k] = Number(el.value);
  });

  const likertIds = ["umux_req", "umux_easy", "peffort", "trust", "control", "satisfaction"];
  for (const id of likertIds) {
    const checked = document.querySelector(`input[name="${cssEscape(id)}"]:checked`);
    out[id] = checked ? Number(checked.value) : null;
  }

  return out;
}

function validateSurvey(s) {
  const tlxIds = ["tlx_mental", "tlx_physical", "tlx_temporal", "tlx_performance", "tlx_effort", "tlx_frustration"];
  for (const id of tlxIds) if (typeof s[id] !== "number") return false;

  const likertIds = ["umux_req", "umux_easy", "peffort", "trust", "control", "satisfaction"];
  for (const id of likertIds) if (!s[id]) return false;

  return true;
}

async function onSubmitSurvey() {
  setText("surveyStatus", "");

  const s = collectSurvey();
  if (!validateSurvey(s)) {
    setText("surveyStatus", "Please answer all questions before submitting.");
    return;
  }

  session.survey = s;
  session.surveySubmittedAt = Date.now();

  await writeFinal({
    condition: session.condition,
    startedAt: session.startedAt,
    checkoutCompletedAt: session.checkoutCompletedAt,
    surveySubmittedAt: session.surveySubmittedAt,
    taskDurationMs: session.taskDurationMs,
    conversion_completed: true,
    transitions: session.transitions,
    answers: session.answers,
    input_method_by_step: session.input_method_by_step,
    survey: session.survey,
  });

  setText("surveyStatus", "Submitted. Thank you!");
  const btn = document.getElementById("surveySubmitBtn");
  if (btn) btn.disabled = true;
}

/***********************
 * UI pieces
 ***********************/
function optionsGrid(id, options) {
  return `
    <div class="optionGrid">
      ${options
        .map((opt) => {
          const selected = answers[id] === opt ? "selected" : "";
          return `
          <div class="optionCard ${selected}" role="button" tabindex="0"
               data-step="${escapeAttr(id)}" data-value="${escapeAttr(opt)}">
            ${escapeHtml(opt)}
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}

function recipientQtyField() {
  ensureRecipient1Defaults();
  const v = clampInt(Number(answers.r1_qty ?? 1), 1, 10);
  return `
    <div class="field">
      <label class="fieldLabel">Quantity</label>
      <input id="recipientQty" type="number" min="1" max="10" value="${escapeAttr(String(v))}" />
      <p class="muted small" style="margin-top:10px;">Simulated (no PII).</p>
    </div>
  `;
}

function recipientAmountField() {
  ensureRecipient1Defaults();
  const amt = clampInt(Number(answers.r1_amt ?? 50), 5, 2000);
  const presets = [25, 50, 75, 100, 150, 200];
  const isCustom = !presets.includes(amt);

  return `
    <div class="field">
      <label class="fieldLabel">Gift Amount</label>
      <div class="amountChips">
        ${presets
          .map(
            (v) => `
          <button type="button" class="chipBtn ${amt === v ? "active" : ""}" data-amt-value="${v}">
            $${v}
          </button>
        `
          )
          .join("")}
        <button type="button" class="chipBtn ${isCustom ? "active" : ""}" data-amt-value="custom">
          Custom
        </button>
      </div>

      <div class="customAmtRow">
        <span class="muted">$</span>
        <input id="recipientAmt" type="number" min="5" max="2000" value="${escapeAttr(String(amt))}" />
      </div>
    </div>
  `;
}

function recipientMsgField() {
  ensureRecipient1Defaults();
  const msg = String(answers.r1_msg ?? "");
  return `
    <div class="field">
      <label class="fieldLabel">Gift Message (optional)</label>
      <input id="recipientMsg" type="text"
        placeholder="(Simulated) e.g., Happy Birthday!"
        value="${escapeAttr(msg)}" />
      <p class="muted small" style="margin-top:10px;">
        Avoid personal info. Use generic text.
      </p>
    </div>
  `;
}

function designPicker() {
  ensureDesignDefaults();
  const activeCat = answers.design_category ?? "All";
  const categories = ["All", ...Array.from(new Set(CARD_DESIGNS.map((d) => d.category)))];
  const filtered = activeCat === "All" ? CARD_DESIGNS : CARD_DESIGNS.filter((d) => d.category === activeCat);

  return `
    <div>
      <div class="chipRow" id="designChips">
        ${categories
          .map(
            (ca) => `
          <div class="chip ${ca === activeCat ? "active" : ""}" role="button" tabindex="0" data-chip="${escapeAttr(ca)}">
            ${escapeHtml(ca)}
          </div>
        `
          )
          .join("")}
      </div>

      <div class="designGrid" id="designGrid">
        ${filtered
          .map((d) => {
            const sel = answers.design === d.id ? "selected" : "";
            return `
            <div class="designThumb ${d.style} ${sel}" role="button" tabindex="0" data-design="${escapeAttr(d.id)}">
              <div class="label">${escapeHtml(d.label)}</div>
              <div class="cat">${escapeHtml(d.category)}</div>
            </div>
          `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function displayBlock(helperText, content) {
  const safeContent = escapeHtml(content).replaceAll("\n", "<br/>");
  return `
    <div class="field">
      <p class="muted small" style="margin:0 0 10px 0;">${escapeHtml(helperText)}</p>
      <div style="border:1px solid var(--border); border-radius:12px; padding:12px; background:#fff;">
        <strong style="white-space:pre-line;">${safeContent}</strong>
      </div>
    </div>
  `;
}

/***********************
 * Wiring
 ***********************/
function wireStepInteractions(stepObj) {
  // B: modality selection UI
  if (CONDITION === "B") {
    document.querySelectorAll("[data-im]").forEach((el) => {
      el.addEventListener("click", () => {
        currentInputMethod = el.getAttribute("data-im") || "standard";
        session.input_method_by_step[stepObj.id] = currentInputMethod;

        document.getElementById("stepContainer").innerHTML = stepObj.render(stepObj);
        wireStepInteractions(stepObj);
        refreshPreview();
        updateNextButtonState(stepObj);
      });
    });

    if (currentInputMethod === "voice") wireVoice(stepObj);
    if (currentInputMethod === "chat") wireChat(stepObj);
  }

  // C: locked modality
  if (CONDITION === "C") {
    if (currentInputMethod === "voice") wireVoice(stepObj);
    if (currentInputMethod === "chat") wireChat(stepObj);
  }

  // Disable manual UI when NOT allowed (B voice/chat OR C non-standard)
  const manualAllowed = isManualInputAllowedForCurrentStep(stepObj);
  if (!manualAllowed) {
    disableManualControls();
  }

  // option cards
  document.querySelectorAll(".optionCard[data-step]").forEach((el) => {
    el.addEventListener("click", () => {
      if (!isManualInputAllowedForCurrentStep(stepObj)) return;

      const stepId = el.getAttribute("data-step");
      const val = el.getAttribute("data-value");
      setAnswer(stepId, val);
      highlightOption(stepId, val);
      refreshPreview();
      updateNextButtonState(stepObj);
    });
  });

  // design chips
  const chipRow = document.getElementById("designChips");
  if (chipRow) {
    chipRow.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        if (!isManualInputAllowedForCurrentStep(stepObj)) return;

        setAnswer("design_category", chip.getAttribute("data-chip") || "All");
        document.getElementById("stepContainer").innerHTML = stepObj.render(stepObj);
        wireStepInteractions(stepObj);
        refreshPreview();
        updateNextButtonState(stepObj);
      });
    });
  }

  // design thumbs
  const grid = document.getElementById("designGrid");
  if (grid) {
    grid.querySelectorAll(".designThumb").forEach((thumb) => {
      thumb.addEventListener("click", () => {
        if (!isManualInputAllowedForCurrentStep(stepObj)) return;

        setAnswer("design", thumb.getAttribute("data-design"));
        grid.querySelectorAll(".designThumb").forEach((x) => x.classList.remove("selected"));
        thumb.classList.add("selected");
        refreshPreview();
        updateNextButtonState(stepObj);
      });
    });
  }

  // qty
  const qty = document.getElementById("recipientQty");
  if (qty) {
    qty.addEventListener("input", () => {
      if (!isManualInputAllowedForCurrentStep(stepObj)) return;
      setAnswer("r1_qty", qty.value);
      refreshPreview();
      updateNextButtonState(stepObj);
    });
  }

  // amount
  const amt = document.getElementById("recipientAmt");
  if (amt) {
    amt.addEventListener("input", () => {
      if (!isManualInputAllowedForCurrentStep(stepObj)) return;
      setAnswer("r1_amt", amt.value);
      refreshPreview();
      updateNextButtonState(stepObj);
    });
  }

  document.querySelectorAll("[data-amt-value]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!isManualInputAllowedForCurrentStep(stepObj)) return;

      const v = btn.getAttribute("data-amt-value");
      if (v && v !== "custom") {
        setAnswer("r1_amt", String(v));
        document.getElementById("stepContainer").innerHTML = stepObj.render(stepObj);
        wireStepInteractions(stepObj);
        refreshPreview();
        updateNextButtonState(stepObj);
      } else {
        const i = document.getElementById("recipientAmt");
        if (i) i.focus();
      }
    });
  });

  // message
  const msg = document.getElementById("recipientMsg");
  if (msg) {
    msg.addEventListener("input", () => {
      if (!isManualInputAllowedForCurrentStep(stepObj)) return;
      setAnswer("r1_msg", msg.value);
      updateNextButtonState(stepObj);
    });
  }
}

function disableManualControls() {
  const disableEls = (selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      el.style.pointerEvents = "none";
      el.style.opacity = "0.55";
      el.setAttribute("aria-disabled", "true");
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.disabled = true;
      if (el.tagName === "BUTTON") el.disabled = true;
    });
  };

  disableEls(".optionCard[data-step]");
  disableEls("#designChips .chip");
  disableEls(".designThumb");
  disableEls("[data-amt-value]");
  disableEls("#recipientQty, #recipientAmt, #recipientMsg");
}

/***********************
 * Voice / Chat apply
 ***********************/
function wireVoice(stepObj) {
  const startBtn = document.getElementById("voiceStartBtn");
  const stopBtn = document.getElementById("voiceStopBtn");
  const out = document.getElementById("voiceTranscript");
  if (!startBtn || !stopBtn || !out) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    out.textContent = "Voice not supported. Use Standard or Chat.";
    return;
  }

  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.continuous = false;

  let recognizing = false;

  rec.onresult = (e) => {
    const t = (e.results?.[0]?.[0]?.transcript || "").trim();
    out.textContent = t ? `Heard: "${t}"` : "No speech detected.";
    if (t) applyFreeformToStep(stepObj, t);
  };

  rec.onerror = (e) => {
    out.textContent = `Voice error: ${e.error}`;
  };

  rec.onend = () => {
    recognizing = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  };

  startBtn.onclick = () => {
    try {
      rec.start();
      recognizing = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      out.textContent = "Listening…";
    } catch {
      out.textContent = "Could not start voice. Try again.";
    }
  };

  stopBtn.onclick = () => {
    if (recognizing) rec.stop();
  };
}

function wireChat(stepObj) {
  const input = document.getElementById("chatInput");
  const btn = document.getElementById("chatSendBtn");
  const log = document.getElementById("chatLog");
  if (!input || !btn || !log) return;

  const send = () => {
    const t = (input.value || "").trim();
    if (!t) return;
    log.textContent = `You: "${t}"`;
    applyFreeformToStep(stepObj, t);
    input.value = "";
  };

  btn.onclick = send;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
}

function applyFreeformToStep(stepObj, raw) {
  const text = normalizeText(raw);

  if (stepObj.kind === "choice") {
    const best = bestOptionMatch(text, stepObj.options || []);
    if (best) {
      setAnswer(stepObj.id, best);
      highlightOption(stepObj.id, best);
      refreshPreview();
      updateNextButtonState(stepObj);
    }
    return;
  }

  if (stepObj.kind === "design") {
    const labels = CARD_DESIGNS.map((d) => d.label);
    const bestLabel = bestOptionMatch(text, labels);
    if (bestLabel) {
      const d = CARD_DESIGNS.find((x) => x.label === bestLabel);
      if (d) setAnswer("design", d.id);
      refreshPreview();
      updateNextButtonState(stepObj);
    }
    return;
  }

  if (stepObj.kind === "number") {
    const n = parseSpokenNumberClosest(raw, { min: 1, max: 10, fallback: Number(answers.r1_qty || 1) });
    setAnswer("r1_qty", String(n));
    const qty = document.getElementById("recipientQty");
    if (qty) qty.value = String(n);
    refreshPreview();
    updateNextButtonState(stepObj);
    return;
  }

  if (stepObj.kind === "amount") {
    const n = parseSpokenNumberClosest(raw, { min: 5, max: 2000, fallback: Number(answers.r1_amt || 50) });
    setAnswer("r1_amt", String(n));
    const amt = document.getElementById("recipientAmt");
    if (amt) amt.value = String(n);
    refreshPreview();
    updateNextButtonState(stepObj);
    return;
  }

  if (stepObj.kind === "text") {
    const cleaned = raw.trim().slice(0, 140);
    setAnswer("r1_msg", cleaned);
    const msg = document.getElementById("recipientMsg");
    if (msg) msg.value = cleaned;
    updateNextButtonState(stepObj);
  }
}

/***********************
 * Answer + highlight
 ***********************/
function setAnswer(key, value) {
  answers[key] = value;
  session.answers[key] = value;

  // If card_type switches, clear branch-specific answers
  if (key === "card_type") {
    if (value === "Digital") {
      delete answers.packaging; delete session.answers.packaging;
      delete answers.shipping_method; delete session.answers.shipping_method;
      delete answers.shipping_address; delete session.answers.shipping_address;
    } else if (value === "Physical") {
      delete answers.digital_delivery; delete session.answers.digital_delivery;
      delete answers.digital_identifier; delete session.answers.digital_identifier;
    }
  }
}

function highlightOption(stepId, val) {
  document.querySelectorAll(`.optionCard[data-step="${cssEscape(stepId)}"]`).forEach((x) => x.classList.remove("selected"));
  const el = document.querySelector(`.optionCard[data-step="${cssEscape(stepId)}"][data-value="${cssEscape(val)}"]`);
  if (el) el.classList.add("selected");
}

/***********************
 * Transitions
 ***********************/
function recordTransition(action, fromStep, toStep, flowLength) {
  const now = Date.now();
  session.transitions.push({
    action,
    from_step_id: fromStep?.id ?? null,
    from_step_index: currentStep,
    to_step_id: toStep?.id ?? null,
    to_step_index: toStep?.index ?? null,
    step_count: flowLength,
    enteredAt: stepEnteredAt,
    exitedAt: now,
    dwellMs: stepEnteredAt ? now - stepEnteredAt : null,
  });
}

/***********************
 * Preview + price (1 recipient)
 * - Price shows "—" until required pricing inputs are selected
 * - Price never decreases: NO negative adjustments
 ***********************/
function computeTotals() {
  ensureRecipient1Defaults();
  const qty = clampInt(Number(answers.r1_qty ?? 1), 1, 10);
  const amt = clampInt(Number(answers.r1_amt ?? 50), 5, 2000);
  const giftTotal = qty * amt;
  return { qty, amt, giftTotal };
}

// Decide when to show computed price (avoid showing $54 before selections)
function canShowPrice() {
  const type = answers.card_type;
  if (!type) return false;

  // require expiry because it affects price text, and gift amount/qty
  if (!answers.expiry) return false;
  if (!answers.r1_qty || !answers.r1_amt) return false;

  if (type === "Physical") {
    // require packaging + shipping method for physical pricing
    if (!answers.packaging) return false;
    if (!answers.shipping_method) return false;
  } else {
    // digital: no packaging; require digital delivery selection
    if (!answers.digital_delivery) return false;
  }

  return true;
}

function computePrice() {
  const { giftTotal } = computeTotals();
  let total = giftTotal;

  const expiry = answers.expiry;
  const cardType = answers.card_type;

  // Expiry adjustments (ONLY add; never subtract)
  if (expiry && expiry.startsWith("No expiry")) total += 6.0;
  if (expiry && expiry.startsWith("12-month")) total += 2.0;

  // Physical-only add-ons
  if (cardType === "Physical") {
    const packaging = answers.packaging || "Greeting card";
    const shippingMethod = answers.shipping_method || "Standard shipping";

    if (packaging.includes("Trifold")) total += 2.5;
    if (packaging.includes("Box")) total += 4.0;

    total += shippingMethod.includes("Expedited") ? 12.0 : 4.0;
  }

  return Math.max(total, 10);
}

function refreshPreview() {
  ensureRecipient1Defaults();
  ensureDesignDefaults();

  const design = CARD_DESIGNS.find((d) => d.id === answers.design) || CARD_DESIGNS[1];
  const previewCard = document.getElementById("previewCard");
  if (previewCard) previewCard.className = `giftCard ${design.style}`;

  const type = answers.card_type || "—";
  setText("previewType", type === "—" ? "—" : type);
  setText("previewDesignName", design.label);
  setText("previewOccasion", (answers.design_category && answers.design_category !== "All") ? answers.design_category : "Any Occasion");

  // Expiry text
  setText("previewExpiry", answers.expiry || "—");

  // Delivery/Shipping line
  if (!answers.card_type) {
    setText("previewDelivery", "Delivery/Shipping: —");
  } else if (answers.card_type === "Digital") {
    setText("previewDelivery", `Delivery: ${(answers.digital_delivery || "—")} (synthetic)`);
  } else {
    setText("previewDelivery", `Shipping: ${(answers.shipping_method || "—")} (fictional)`);
  }

  const totals = computeTotals();
  setText("previewAmount", answers.r1_amt ? `$${totals.amt}` : "—");

  // Summary box
  setText("sumCards", answers.r1_qty ? String(totals.qty) : "—");
  setText("sumGiftTotal", answers.r1_amt && answers.r1_qty ? `$${totals.giftTotal.toFixed(0)}` : "—");

  // Price: only show once enough selections exist
  const show = canShowPrice();
  setText("buyPrice", show ? `$${computePrice().toFixed(2)}` : "—");

  const pill = document.getElementById("conditionPill");
  if (pill) pill.textContent = `Condition ${CONDITION}`;
}

/***********************
 * Screen helper
 ***********************/
function showScreen(id) {
  ["introScreen", "checkoutScreen", "surveyScreen"].forEach((sid) => {
    const el = document.getElementById(sid);
    if (!el) return;
    el.classList.toggle("active", sid === id);
  });
}

/***********************
 * Init + navigation
 ***********************/
document.addEventListener("DOMContentLoaded", () => {
  const pill = document.getElementById("conditionPill");
  if (pill) pill.textContent = `Condition ${CONDITION}`;

  const startBtn = document.getElementById("startBtn");
  const backBtn = document.getElementById("backBtn");
  const nextBtn = document.getElementById("nextBtn");

  startBtn?.addEventListener("click", () => {
    session.startedAt = Date.now();
    showScreen("checkoutScreen");

    // defaults (so qty=1 and amount=50 always exist)
    setAnswer("design_category", "All");
    setAnswer("design", "confetti");
    setAnswer("r1_qty", "1");
    setAnswer("r1_amt", "50");
    setAnswer("r1_msg", "");

    // Condition A standard; Condition B starts standard; Condition C set per step in renderStep
    currentInputMethod = "standard";

    currentStep = 0;
    renderStep();
  });

  nextBtn?.addEventListener("click", () => {
    const flow = computeFlow();
    const stepObj = flow[currentStep];

    if (!isStepComplete(stepObj)) {
      alert("Please complete the required fields to continue.");
      return;
    }

    const nextIndex = currentStep + 1;
    recordTransition("next", stepObj, flow[nextIndex] ? { ...flow[nextIndex], index: nextIndex } : null, flow.length);

    currentStep++;
    renderStep();
  });

  backBtn?.addEventListener("click", () => {
    if (currentStep <= 0) return;

    const flow = computeFlow();
    const prevIndex = currentStep - 1;
    recordTransition("back", flow[currentStep], flow[prevIndex] ? { ...flow[prevIndex], index: prevIndex } : null, flow.length);

    currentStep--;
    renderStep();
  });
});

/***********************
 * Matching + parsing
 ***********************/
function bestOptionMatch(input, options) {
  if (!input || !options?.length) return null;
  const clean = normalizeText(input);

  let direct = options.find((o) => normalizeText(o) === clean);
  if (direct) return direct;

  direct = options.find((o) => normalizeText(o).includes(clean)) || options.find((o) => clean.includes(normalizeText(o)));
  if (direct) return direct;

  const inToks = new Set(clean.split(" ").filter(Boolean));
  let best = null;
  let bestScore = -1;

  for (const o of options) {
    const ot = normalizeText(o);
    const oToks = ot.split(" ").filter(Boolean);
    let score = 0;
    for (const t of oToks) if (inToks.has(t)) score += 1;
    if (ot.startsWith(clean)) score += 0.5;
    if (clean.startsWith(ot)) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return bestScore >= 1 ? best : null;
}

function parseSpokenNumberClosest(raw, { min = 1, max = 10, fallback = 1 } = {}) {
  if (!raw) return clampInt(fallback, min, max);

  const s = String(raw).toLowerCase();

  const digitMatch = s.match(/-?\d+/);
  if (digitMatch) return clampInt(Number(digitMatch[0]), min, max);

  const map = {
    zero: 0,
    one: 1,
    won: 1,
    two: 2,
    to: 2,
    too: 2,
    three: 3,
    four: 4,
    for: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    ate: 8,
    nine: 9,
    ten: 10,
  };
  for (const [k, v] of Object.entries(map)) {
    if (s.includes(k)) return clampInt(v, min, max);
  }

  return clampInt(fallback, min, max);
}

/***********************
 * Utilities
 ***********************/
function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function cssEscape(s) {
  return String(s).replaceAll('"', '\\"');
}

function clampInt(n, min, max) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
