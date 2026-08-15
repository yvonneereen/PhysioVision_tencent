import {
  getMe, getPatients, isLoggedIn,
  getExercises, getPrescriptions, createPrescription, assignAiDraftProgramme,
  getConsultations, initiateConsultation, updateConsultation, confirmConsultation, cancelConsultation, completeConsultation,
  getPatientSessions, getPatientPainCheckins,
  getCareMessages, sendCareMessage, getCareMessageThreads,
  getClinicianAiSession, getClinicianAiSessions, sendAgentMessage,
  getTriageQueue, claimTriagePatient, declineTriagePatient,
  dischargePatient,
} from "./api.js?v=36";
import { excludeRosterPatientsFromTriage } from "./therapist-triage-state.js?v=1";
import { formatClinicalAssistantText } from "./clinical-ai-format.js?v=1";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

const TAB_TITLES = {
  overview: "Patient overview",
  patients: "All patients",
  programmes: "Programmes",
  consultations: "Consultations",
  messaging: "Messaging",
  triage: "Triage queue",
};

// In-memory caches populated on load; tabs render from these.
const state = { patients: [], consultations: [], exercises: [], prescriptions: [], triage: [] };

function formatDate(d) {
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function relativeTime(isoString) {
  if (!isoString) return "Never";
  const diff = Date.now() - new Date(isoString).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function initials(name) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function patientAccountLabel(patient) {
  const name = patient?.full_name || patient?.email || "Patient";
  return patient?.email && patient.email !== name
    ? `${name} — ${patient.email}`
    : name;
}

function trendIcon(trend) {
  if (trend === "improving") return { icon: "↗", cls: "trend-rising" };
  if (trend === "declining") return { icon: "⌁", cls: "trend-falling" };
  return { icon: "—", cls: "trend-flat" };
}

function painBadge(level) {
  if (level === null || level === undefined) return `<span class="pain-badge pain-none">—</span>`;
  const cls = level >= 7 ? "pain-high" : level >= 4 ? "pain-mid" : "pain-low";
  return `<span class="pain-badge ${cls}">${level}/10</span>`;
}

function painSafetyReview(checkin) {
  const safety = checkin?.safety_follow_up ?? {};
  if (!checkin?.requires_review && !safety.outcome) return "";
  const outcomeLabels = {
    urgent: "Urgent stop",
    professional: "Professional review",
    monitor: "Monitor",
  };
  const restLabels = {
    better: "improving after rest",
    same: "unchanged after rest",
    worse: "worse after rest",
    unsure: "change after rest unclear",
  };
  const movementLabels = {
    safe: "can move safely",
    nearby: "needs someone nearby",
    help: "needs help to move safely",
  };
  const painArea = [safety.pain_side, safety.pain_location]
    .filter(Boolean)
    .join(" ");
  const languageNotes = Array.isArray(safety.language_interpretations)
    ? safety.language_interpretations
      .map((item) => String(item?.summary || "").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join("; ")
    : "";
  const details = [
    safety.exercise_name,
    painArea,
    restLabels[safety.rest_trend],
    movementLabels[safety.safe_movement],
    languageNotes ? `AI language interpretation: ${languageNotes}` : "",
  ].filter(Boolean);
  return `
    <span class="pain-review-summary">
      <strong>${escapeHtml(outcomeLabels[safety.outcome] || "Review requested")}</strong>
      <small>${escapeHtml(details.join(" · ") || "Safety follow-up recorded")}</small>
    </span>`;
}

function sessionStopReason(session) {
  const label = {
    pain: "Pain",
    tired: "Tired",
    dizzy: "Dizzy",
    breathless: "Breathless",
    exercise_difficulty: "Exercise difficulty",
    skipped: "Reason skipped",
  }[session?.stop_reason];
  if (!label) return "";
  return session.stop_requires_review
    ? `${label} · Review recorded stop`
    : label;
}

function statusText(patient) {
  if (patient.open_escalations_count > 0) return { label: "Review now", cls: "status-pill-review" };
  if (patient.trend === "declining") return { label: "Monitor", cls: "status-pill-watch" };
  return { label: "On track", cls: "status-pill-good" };
}

function statusPill(patient) {
  const { label, cls } = statusText(patient);
  return `<button class="status-pill ${cls}" type="button">${label}</button>`;
}

function goalLabel(goal) {
  const labels = {
    stronger_knees: "Knee strength",
    better_balance: "Balance",
    less_stiffness: "Stiffness",
    stay_active: "Stay active",
    stronger_hips: "Hip strength",
    shoulder_mobility: "Shoulder mobility",
    ankle_mobility: "Ankle mobility",
    walking_confidence: "Walking confidence",
  };
  return labels[goal] || goal || "General";
}

const SPARK_TICKS = "▁▂▃▄▅▆▇█";
function sparkline(values, lo, hi) {
  const nums = values.filter(v => v !== null && v !== undefined && v !== "").map(Number);
  if (!nums.length) return "—";
  const span = (hi - lo) || 1;
  return nums.map(n => {
    const idx = Math.round((Math.max(lo, Math.min(hi, n)) - lo) / span * (SPARK_TICKS.length - 1));
    return SPARK_TICKS[idx];
  }).join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function activeProgrammes(patient) {
  if (Array.isArray(patient?.active_prescriptions)) {
    return patient.active_prescriptions.filter(Boolean);
  }
  return patient?.active_prescription ? [patient.active_prescription] : [];
}

function programmeDose(programme) {
  const sets = Number(programme?.sets) || 0;
  const reps = Number(programme?.reps) || 0;
  const holdSeconds = Number(programme?.hold_seconds) || 0;
  const dose = holdSeconds > 0
    ? `${sets}×${holdSeconds}s`
    : `${sets}×${reps}`;
  return `${dose} · ${programme?.days_per_week || "—"}×/wk`;
}

function patientProgrammeCell(patient) {
  const programmes = activeProgrammes(patient);
  if (!programmes.length) return `<span class="patient-programme-empty">No programme</span>`;
  return `
    <span class="patient-programme-list" aria-label="${programmes.length} assigned programme${programmes.length === 1 ? "" : "s"}">
      ${programmes.map((programme) => `
        <span class="patient-programme-item">
          <strong>${escapeHtml(programme.exercise_name || "Exercise")}</strong>
          <small>${escapeHtml(programme.days_per_week || "—")}×/wk</small>
        </span>`).join("")}
    </span>`;
}

function patientProgrammeDetail(patient) {
  const programmes = activeProgrammes(patient);
  if (!programmes.length) return `<strong class="detail-programme-empty">No active programme</strong>`;
  return `
    <div class="detail-programme-list">
      ${programmes.map((programme) => `
        <div class="detail-programme-item">
          <strong>${escapeHtml(programme.exercise_name || "Exercise")}</strong>
          <small>${escapeHtml(programmeDose(programme))}</small>
        </div>`).join("")}
    </div>`;
}

// ── Patients ────────────────────────────────────────────────

function renderPatientRow(patient) {
  const name       = patient.full_name || "Unknown";
  const age        = patient.age ? `${patient.age} · ` : "";
  const goal       = goalLabel(patient.goal);
  const ini        = initials(name);
  const lastSess   = relativeTime(patient.last_session_at);
  const { icon, cls } = trendIcon(patient.trend);

  return `
    <div class="patient-row is-clickable" data-patient-id="${patient.id}">
      <span class="patient-name">
        <i class="avatar">${ini}</i>
        <span><strong>${escapeHtml(name)}</strong><small>${age}${goal}</small></span>
      </span>
      ${patientProgrammeCell(patient)}
      <span>${lastSess}</span>
      <span class="mini-trend ${cls}">${icon}</span>
      <span>${painBadge(patient.latest_pain_level)}</span>
      <span>${statusPill(patient)}</span>
    </div>`;
}

function renderStats(patients) {
  const total      = patients.length;
  const needReview = patients.filter(p => p.open_escalations_count > 0).length;
  const adherences = patients.map(p => p.adherence_pct).filter(v => v !== null);
  const avgAdh     = adherences.length
    ? Math.round(adherences.reduce((a, b) => a + b, 0) / adherences.length)
    : null;

  document.getElementById("stat-active-patients").textContent = total;
  document.getElementById("stat-active-sub").textContent      = `${total} under your care`;
  document.getElementById("stat-need-review").textContent     = needReview;
  document.getElementById("stat-review-sub").textContent      = needReview > 0
    ? `${needReview} open escalation${needReview > 1 ? "s" : ""}`
    : "All clear";
  document.getElementById("stat-need-review")
    ?.parentElement
    ?.classList.toggle("has-review", needReview > 0);
  document.getElementById("stat-adherence").textContent       = avgAdh !== null ? `${avgAdh}%` : "—";
  document.getElementById("stat-adherence-sub").textContent   = avgAdh !== null
    ? (avgAdh >= 80 ? "↑ On track" : "↓ Below target")
    : "No prescriptions yet";
}

function sortByPriority(patients) {
  return [...patients].sort((a, b) => {
    const score = p => (p.open_escalations_count > 0 ? 2 : 0) + (p.trend === "declining" ? 1 : 0);
    return score(b) - score(a);
  });
}

function renderPatientTable(patients) {
  const body = document.getElementById("patient-table-body");
  if (!body) return;
  const query = (document.getElementById("patient-search")?.value || "").toLowerCase();
  const filtered = patients.filter(p => (p.full_name || "").toLowerCase().includes(query));

  if (filtered.length === 0) {
    body.innerHTML = `<p class="empty-state">No patients ${query ? "match that search" : "assigned to your account yet"}.</p>`;
    return;
  }
  body.innerHTML = sortByPriority(filtered).map(renderPatientRow).join("");
}

async function showPatientDetail(patientId) {
  const patient = state.patients.find(p => String(p.id) === String(patientId));
  const panel = document.getElementById("patient-detail");
  if (!patient || !panel) return;

  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="empty-state">Loading ${escapeHtml(patient.full_name)}…</p>`;

  try {
    const [sessRaw, painRaw, msgRaw] = await Promise.all([
      getPatientSessions(patientId),
      getPatientPainCheckins(patientId),
      getCareMessages(patientId).catch(() => []),
    ]);
    const sessions = (Array.isArray(sessRaw) ? sessRaw : sessRaw.results ?? []);
    const pains    = (Array.isArray(painRaw) ? painRaw : painRaw.results ?? []);
    const messages = (Array.isArray(msgRaw) ? msgRaw : msgRaw.results ?? []);

    const recent = [...sessions].reverse();       // oldest → newest
    const qSpark = sparkline(recent.map((session) => (
      session.assessment_summary?.movement_execution?.status === "assessed"
        ? session.assessment_summary.movement_execution.score
        : null
    )), 0, 100);
    const pSpark = sparkline(recent.map(s => s.pain_level), 0, 10);
    const { label, cls } = statusText(patient);

    const sessionRows = sessions.slice(0, 8).map((s) => {
      const assessment = s.assessment_summary ?? {};
      const tracking = {
        assessable: "Tracking assessable",
        partially_assessable: "Tracking partly assessable",
        unable_to_assess: "Tracking unable to assess",
      }[assessment.tracking_validity?.status] ?? "Tracking not recorded";
      const execution = assessment.movement_execution?.status === "assessed"
        ? `Coaching response ${assessment.movement_execution.score}/100`
        : assessment.movement_execution?.status === "prototype_scored"
          ? `Prototype movement score ${assessment.movement_execution.score}/100`
          : assessment.movement_execution?.status === "not_clinically_scored"
          ? "Execution not clinically scored"
          : "Execution unable to assess";
      return `
        <div class="detail-row">
          <span>${escapeHtml(s.exercise_name || s.exercise || "Exercise")}</span>
          <span>${new Date(s.started_at).toLocaleDateString()}</span>
          <span>${s.reps_completed}/${s.reps_minimum || s.reps_target} minimum reps</span>
          <span>${escapeHtml(tracking)}</span>
          <span>${escapeHtml(execution)}</span>
          <span>${sessionStopReason(s) ? `Stopped: ${escapeHtml(sessionStopReason(s))}` : painBadge(s.pain_level)}</span>
        </div>`;
    }).join("") || `<p class="empty-state">No sessions logged.</p>`;

    const painRows = pains.slice(0, 5).map(p => `
      <div class="detail-row">
        <span>${new Date(p.checked_at).toLocaleDateString()}</span>
        <span>${painBadge(p.pain_level)}</span>
        <span>${escapeHtml(p.timing || "")}</span>
        <span>${escapeHtml(p.location_notes || "")}</span>
        ${painSafetyReview(p)}
      </div>`).join("") || `<p class="empty-state">No pain check-ins.</p>`;

    const programmes = activeProgrammes(patient);

    panel.innerHTML = `
      <div class="detail-head">
        <div>
          <h3>${escapeHtml(patient.full_name)}</h3>
          <p>${patient.age ? patient.age + " · " : ""}${goalLabel(patient.goal)} · ${escapeHtml(patient.care_path || "")}</p>
        </div>
        <div class="detail-head-right">
          <span class="status-pill ${cls}">${label}</span>
          <button class="button button-discharge button-small" type="button" id="detail-discharge" aria-expanded="false" aria-controls="discharge-confirm">Discharge patient</button>
          <button class="button button-dark button-small" type="button" id="detail-close">Close</button>
        </div>
      </div>
      <form class="discharge-confirm hidden" id="discharge-confirm">
        <div>
          <strong>Discharge ${escapeHtml(patient.full_name)} from your care?</strong>
          <p>Their active clinician programme and pending appointments will end. Their account, sessions, messages, and care history will remain saved, and they can request support again later.</p>
        </div>
        <label>
          <span>Discharge note for the patient <small>(optional)</small></span>
          <textarea id="discharge-note" rows="2" maxlength="500" placeholder="For example: You have met the goals we agreed on."></textarea>
        </label>
        <div class="discharge-confirm-actions">
          <button class="button button-light button-small" type="button" id="discharge-cancel">Keep patient</button>
          <button class="button button-discharge button-small" type="submit">Confirm discharge</button>
        </div>
        <p class="discharge-error" id="discharge-error" hidden></p>
      </form>
      <div class="detail-metrics">
        <div><span>Validated coaching-response trend</span><code>${qSpark}</code></div>
        <div><span>Pain trend</span><code>${pSpark}</code></div>
        <div><span>Adherence</span><strong>${patient.adherence_pct ?? "—"}%</strong></div>
        <div class="detail-programme-metric"><span>Programme · ${programmes.length} assigned</span>${patientProgrammeDetail(patient)}</div>
      </div>
      <div class="detail-section"><strong>Recent sessions</strong>${sessionRows}</div>
      <div class="detail-section"><strong>Pain diary</strong>${painRows}</div>
      <div class="detail-section detail-messages">
        <strong>Messages</strong>
        <div class="detail-messages-thread" id="detail-messages-thread">${careMessageRows(messages)}</div>
        <form class="detail-messages-form" id="detail-messages-form">
          <textarea id="detail-messages-input" rows="2" maxlength="1000"
            placeholder="Reply to ${escapeHtml(patient.full_name)}…"></textarea>
          <button class="button button-coral button-small" type="submit">Send</button>
        </form>
      </div>`;

    panel.querySelector("#detail-close")?.addEventListener("click", () => panel.classList.add("hidden"));
    wirePatientDischarge(panel, patient);
    wireDetailMessaging(panel, patientId);
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    panel.innerHTML = `<p class="empty-state">Could not load patient detail.</p>`;
    console.error("Patient detail failed:", err);
  }
}

function wirePatientDischarge(panel, patient) {
  const openButton = panel.querySelector("#detail-discharge");
  const form = panel.querySelector("#discharge-confirm");
  const cancelButton = panel.querySelector("#discharge-cancel");
  const note = panel.querySelector("#discharge-note");
  const error = panel.querySelector("#discharge-error");
  if (!openButton || !form || !cancelButton || !note || !error) return;

  openButton.addEventListener("click", () => {
    form.classList.remove("hidden");
    openButton.setAttribute("aria-expanded", "true");
    note.focus();
  });
  cancelButton.addEventListener("click", () => {
    form.classList.add("hidden");
    openButton.setAttribute("aria-expanded", "false");
    error.hidden = true;
    error.textContent = "";
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Discharging…";
    error.hidden = true;
    error.textContent = "";
    try {
      const result = await dischargePatient(patient.id, note.value.trim());
      state.patients = state.patients.filter(
        item => String(item.id) !== String(patient.id),
      );
      state.consultations = state.consultations.map(consultation => (
        String(consultation.patient) === String(patient.id)
        && ["requested", "confirmed"].includes(consultation.status)
          ? { ...consultation, status: "cancelled" }
          : consultation
      ));
      try {
        const [patientsData, consultationsData] = await Promise.all([
          getPatients(),
          getConsultations(),
        ]);
        state.patients = Array.isArray(patientsData)
          ? patientsData
          : patientsData.results ?? [];
        state.consultations = Array.isArray(consultationsData)
          ? consultationsData
          : consultationsData.results ?? [];
      } catch (refreshError) {
        console.warn("Roster refresh after discharge failed:", refreshError);
      }
      renderStats(state.patients);
      renderOverview(state.patients, state.consultations);
      renderPatientTable(state.patients);
      panel.innerHTML = `
        <div class="discharge-success" role="status">
          <strong>${escapeHtml(patient.full_name)} has been discharged</strong>
          <p>${escapeHtml(result.detail || "The patient is no longer in your active roster.")} Their care history remains saved.</p>
          <button class="button button-dark button-small" type="button" id="detail-close">Close</button>
        </div>`;
      panel.querySelector("#detail-close")?.addEventListener("click", () => panel.classList.add("hidden"));
    } catch (requestError) {
      error.textContent = requestError.message || "Could not discharge this patient.";
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = "Confirm discharge";
    }
  });
}

function careMessageRows(messages) {
  if (!messages.length) {
    return `<p class="empty-state">No messages yet.</p>`;
  }
  return messages.map(m => {
    const mine = m.sender === "clinician";
    const when = new Date(m.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    const who = mine ? "You" : escapeHtml(m.sender_name || "Patient");
    return `
      <div class="care-message ${mine ? "care-message-mine" : "care-message-theirs"}">
        <p class="care-message-body">${escapeHtml(m.body)}</p>
        <span class="care-message-meta">${who} · ${when}</span>
      </div>`;
  }).join("");
}

function wireDetailMessaging(panel, patientId) {
  const form = panel.querySelector("#detail-messages-form");
  const input = panel.querySelector("#detail-messages-input");
  const thread = panel.querySelector("#detail-messages-thread");
  if (!form || !input || !thread) return;
  thread.scrollTop = thread.scrollHeight;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    form.querySelector("button").disabled = true;
    try {
      await sendCareMessage(body, patientId);
      input.value = "";
      const data = await getCareMessages(patientId);
      thread.innerHTML = careMessageRows(Array.isArray(data) ? data : data.results ?? []);
      thread.scrollTop = thread.scrollHeight;
    } catch (err) {
      console.error("Reply failed:", err);
    } finally {
      form.querySelector("button").disabled = false;
    }
  });
}

function consultationHasFutureSchedule(consultation, now = Date.now()) {
  if (!consultation?.scheduled_at) return false;
  const scheduledAt = new Date(consultation.scheduled_at).getTime();
  return Number.isFinite(scheduledAt) && scheduledAt >= now;
}

function isActiveConsultation(consultation, now = Date.now()) {
  if (!["requested", "confirmed"].includes(consultation?.status)) return false;
  if (consultation.status === "requested" && !consultation.scheduled_at) return true;
  return consultationHasFutureSchedule(consultation, now);
}

function consultationSort(a, b) {
  const aIsUnscheduled = !a.scheduled_at;
  const bIsUnscheduled = !b.scheduled_at;
  if (aIsUnscheduled !== bIsUnscheduled) return aIsUnscheduled ? -1 : 1;
  if (aIsUnscheduled) {
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  }
  return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
}

function consultationWhen(consultation) {
  if (!consultation.scheduled_at) return "Not scheduled yet";
  return new Date(consultation.scheduled_at).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function localDateInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// ── Overview ────────────────────────────────────────────────

function renderOverview(patients, consultations) {
  const attention = document.getElementById("overview-attention");
  if (attention) {
    const flagged = sortByPriority(
      patients.filter(p => p.open_escalations_count > 0 || p.trend === "declining")
    ).slice(0, 5);
    attention.innerHTML = flagged.length
      ? flagged.map(p => {
          const reason = p.open_escalations_count > 0
            ? `${p.open_escalations_count} open escalation${p.open_escalations_count > 1 ? "s" : ""}`
            : "Declining trend";
          return `
            <div class="patient-row is-clickable" data-patient-id="${p.id}">
              <span class="patient-name"><i class="avatar">${initials(p.full_name || "?")}</i>
                <span><strong>${escapeHtml(p.full_name)}</strong><small>${reason}</small></span></span>
              <span>${painBadge(p.latest_pain_level)}</span>
              <span>${statusPill(p)}</span>
            </div>`;
        }).join("")
      : `<p class="empty-state">🎉 Everyone is on track.</p>`;
  }

  const upcoming = document.getElementById("overview-consultations");
  if (upcoming) {
    const now = Date.now();
    const next = consultations
      .filter(c => isActiveConsultation(c, now))
      .sort(consultationSort)
      .slice(0, 3);
    upcoming.innerHTML = next.length
      ? next.map(c => `
          <div class="detail-row">
            <span><strong>${escapeHtml(c.patient_name || "Patient")}</strong></span>
            <span>${consultationWhen(c)}</span>
            <span class="consult-status consult-${c.status}">${c.status}</span>
          </div>`).join("")
      : `<p class="empty-state">No upcoming consultations.</p>`;
  }
}

// ── Programmes ──────────────────────────────────────────────

function renderProgrammes() {
  const patientSel  = document.getElementById("rx-patient");
  const exerciseSel = document.getElementById("rx-exercise");
  const filterPatientSel = document.getElementById("rx-filter-patient");
  const filterStatusSel = document.getElementById("rx-filter-status");
  const filterCompletionSel = document.getElementById("rx-filter-completion");
  const list        = document.getElementById("rx-list");

  if (patientSel) {
    patientSel.innerHTML = state.patients.length
      ? state.patients.map(p => `<option value="${p.id}">${escapeHtml(patientAccountLabel(p))}</option>`).join("")
      : `<option value="">No linked patients yet</option>`;
  }
  if (exerciseSel) {
    const active = state.exercises.filter(e => e.is_active);
    exerciseSel.disabled = active.length === 0;
    exerciseSel.innerHTML = active.length
      ? active.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("")
      : `<option value="">Exercise catalogue is not ready</option>`;
  }
  if (filterPatientSel) {
    const selectedPatient = filterPatientSel.value || "all";
    filterPatientSel.innerHTML = `
      <option value="all">All patients</option>
      ${state.patients.map(p => `<option value="${p.id}">${escapeHtml(patientAccountLabel(p))}</option>`).join("")}`;
    filterPatientSel.value = [...filterPatientSel.options].some(option => option.value === selectedPatient)
      ? selectedPatient
      : "all";
  }
  if (list) {
    const today = new Date().toISOString().slice(0, 10);
    const patientFilter = filterPatientSel?.value || "all";
    const statusFilter = filterStatusSel?.value || "all";
    const completionFilter = filterCompletionSel?.value || "all";
    const withStatus = state.prescriptions.map(p => ({
      ...p,
      programmeStatus: p.is_active && (!p.valid_until || p.valid_until >= today)
        ? "active"
        : "ended",
      completionStatus: p.exercise_completed ? "completed" : "not-completed",
    }));
    const filtered = withStatus.filter(p =>
      (patientFilter === "all" || String(p.patient) === patientFilter)
      && (statusFilter === "all" || p.programmeStatus === statusFilter)
      && (completionFilter === "all" || p.completionStatus === completionFilter));
    list.innerHTML = filtered.length
      ? filtered.map(p => `
          <div class="detail-row programme-row">
            <span class="programme-patient"><strong>${escapeHtml(p.patient_name)}</strong>${p.patient_email ? `<small>${escapeHtml(p.patient_email)}</small>` : ""}</span>
            <span>${escapeHtml(p.exercise_name)}</span>
            <span>${p.sets}×${p.reps}</span>
            <span>${escapeHtml(p.days_per_week)}×/wk</span>
            <span class="programme-status programme-status-${p.programmeStatus}">${p.programmeStatus}</span>
            <span class="programme-status programme-status-${p.completionStatus}">${p.exercise_completed ? "Completed" : "Not completed"}</span>
          </div>`).join("")
      : `<p class="empty-state">No programmes match these filters.</p>`;
  }
}

async function submitPrescription(e) {
  e.preventDefault();
  const status = document.getElementById("rx-status");
  const patient  = document.getElementById("rx-patient").value;
  const patientRecord = state.patients.find(
    item => String(item.id) === String(patient)
  );
  const exercise = document.getElementById("rx-exercise").value;
  if (!patient || !exercise) { if (status) status.textContent = "Select a patient and exercise."; return; }

  if (status) status.textContent = "Assigning…";
  try {
    await createPrescription({
      patient,
      exercise,
      sets: Number(document.getElementById("rx-sets").value),
      reps: Number(document.getElementById("rx-reps").value),
      days_per_week: document.getElementById("rx-days").value.trim(),
      valid_from: new Date().toISOString().slice(0, 10),
    });
    if (status) {
      status.textContent = `Programme assigned to ${patientAccountLabel(patientRecord)} ✓`;
    }
    // Refresh prescriptions + patients (adherence/programme change).
    [state.prescriptions, state.patients] = await Promise.all([
      getPrescriptions().then(unwrap),
      getPatients().then(unwrap),
    ]);
    renderProgrammes();
    renderPatientTable(state.patients);
  } catch (err) {
    if (status) status.textContent = err.message || "Could not assign programme.";
  }
}

// ── Consultations ───────────────────────────────────────────

function consultRow(c, withActions) {
  let waiting = "";
  if (c.status === "requested") {
    if (!c.scheduled_at) {
      waiting = `<span class="consult-waiting">Patient requested a consultation</span>`;
    } else {
      waiting = c.initiated_by === "patient"
        ? `<span class="consult-waiting">Patient proposed a time</span>`
        : `<span class="consult-waiting">Awaiting patient</span>`;
    }
  }
  const canSchedule = withActions && c.status === "requested" && !c.scheduled_at;
  const canConfirmLegacy = c.status === "requested"
    && c.initiated_by === "patient"
    && Boolean(c.scheduled_at);
  const canResolve = c.status === "confirmed";
  const actions = withActions ? `
    <span class="consult-actions">
      ${canConfirmLegacy ? `<button class="button button-coral button-small" data-confirm="${c.id}">Confirm</button>` : ""}
      ${canResolve ? `<button class="button button-small button-resolve" data-complete="${c.id}">Resolve</button>` : ""}
      ${["requested", "confirmed"].includes(c.status) ? `<button class="button button-light button-small" data-cancel="${c.id}">Cancel</button>` : ""}
    </span>` : `<span class="consult-status consult-${c.status}">${c.status}</span>`;
  const scheduler = canSchedule ? `
    <form class="consultation-schedule-form" data-schedule-form="${c.id}">
      <label>
        <span>Date</span>
        <input name="date" type="date" min="${localDateInputValue()}" required />
      </label>
      <label>
        <span>Time</span>
        <input name="time" type="time" required />
      </label>
      <label>
        <span>Duration</span>
        <select name="duration">
          <option value="30">30 minutes</option>
          <option value="45">45 minutes</option>
          <option value="60">60 minutes</option>
        </select>
      </label>
      <button class="button button-coral button-small" type="button" data-schedule="${c.id}">
        Send proposed time
      </button>
      <p class="consultation-schedule-status" data-schedule-status="${c.id}" role="status"></p>
    </form>` : "";
  return `
    <div class="consultation-entry">
      <div class="detail-row">
        <span><strong>${escapeHtml(c.patient_name || "Patient")}</strong>${waiting}</span>
        <span>${consultationWhen(c)}</span>
        <span>${c.scheduled_at ? `${c.duration_minutes} min` : "Set when scheduling"}</span>
        ${actions}
      </div>
      ${scheduler}
    </div>`;
}

function renderConsultations() {
  const now = Date.now();
  const upcoming = state.consultations
    .filter(c => isActiveConsultation(c, now))
    .sort(consultationSort);
  const past = state.consultations.filter(c => !upcoming.includes(c));

  const up = document.getElementById("consult-upcoming");
  const pa = document.getElementById("consult-past");
  const patientSelect = document.getElementById("consult-initiate-patient");
  const dateInput = document.getElementById("consult-initiate-date");
  const recommendationList = document.getElementById("consult-recommendation-list");
  if (patientSelect) {
    const selected = patientSelect.value;
    patientSelect.innerHTML = state.patients.length
      ? state.patients.map(patient => `<option value="${patient.id}">${escapeHtml(patientAccountLabel(patient))}</option>`).join("")
      : `<option value="">No linked patients</option>`;
    patientSelect.disabled = state.patients.length === 0;
    if ([...patientSelect.options].some(option => option.value === selected)) patientSelect.value = selected;
  }
  if (dateInput) dateInput.min = localDateInputValue();
  if (recommendationList) {
    const recommended = state.patients.filter(patient =>
      patient.open_escalations_count > 0 || patient.trend === "declining");
    recommendationList.innerHTML = recommended.length
      ? recommended.map(patient => {
          const reasons = [];
          if (patient.open_escalations_count > 0) reasons.push(`${patient.open_escalations_count} open flag${patient.open_escalations_count === 1 ? "" : "s"}`);
          if (patient.trend === "declining") reasons.push("declining movement trend");
          return `<div class="consult-recommendation-row">
            <div><strong>${escapeHtml(patient.full_name || "Patient")}</strong><span>${escapeHtml(reasons.join(" · "))}</span></div>
            <button class="button button-light button-small" type="button" data-initiate-patient="${patient.id}">Propose check-in</button>
          </div>`;
        }).join("")
      : `<p class="empty-state">No patients currently have a declining trend or open flag.</p>`;
  }
  if (up) up.innerHTML = upcoming.length ? upcoming.map(c => consultRow(c, true)).join("") : `<p class="empty-state">No upcoming consultations.</p>`;
  if (pa) pa.innerHTML = past.length ? past.map(c => consultRow(c, false)).join("") : `<p class="empty-state">No past consultations.</p>`;
}

async function submitInitiatedConsultation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById("consult-initiate-status");
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const scheduledAt = new Date(
    `${document.getElementById("consult-initiate-date").value}T${document.getElementById("consult-initiate-time").value}`
  );
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
    status.textContent = "Choose a future date and time.";
    return;
  }
  button.disabled = true;
  status.textContent = "Sending proposal…";
  try {
    await initiateConsultation({
      patient: document.getElementById("consult-initiate-patient").value,
      scheduled_at: scheduledAt.toISOString(),
      duration_minutes: Number(document.getElementById("consult-initiate-duration").value),
      clinician_notes: document.getElementById("consult-initiate-notes").value.trim(),
    });
    state.consultations = await getConsultations().then(unwrap);
    form.reset();
    status.textContent = "Proposal sent. The patient can now accept or decline it.";
    renderConsultations();
    renderOverview(state.patients, state.consultations);
  } catch (error) {
    status.textContent = error.message || "Could not send the consultation proposal.";
  } finally {
    button.disabled = false;
  }
}

async function handleConsultAction(e) {
  const scheduleButton = e.target.closest("[data-schedule]");
  const confirmButton = e.target.closest("[data-confirm]");
  const cancelButton = e.target.closest("[data-cancel]");
  const completeButton = e.target.closest("[data-complete]");
  const actionButton = scheduleButton || confirmButton || cancelButton || completeButton;
  if (!actionButton) return;

  const scheduleId = scheduleButton?.getAttribute("data-schedule");
  const confirmId = confirmButton?.getAttribute("data-confirm");
  const cancelId = cancelButton?.getAttribute("data-cancel");
  const completeId = completeButton?.getAttribute("data-complete");
  actionButton.disabled = true;
  try {
    if (scheduleId) {
      const form = document.querySelector(`[data-schedule-form="${CSS.escape(scheduleId)}"]`);
      const status = form?.querySelector(`[data-schedule-status="${CSS.escape(scheduleId)}"]`);
      if (!form?.reportValidity()) {
        actionButton.disabled = false;
        return;
      }
      const data = new FormData(form);
      const scheduledAt = new Date(`${data.get("date")}T${data.get("time")}`);
      if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
        if (status) status.textContent = "Choose a future date and time.";
        actionButton.disabled = false;
        return;
      }
      if (status) status.textContent = "Sending proposed time…";
      await updateConsultation(scheduleId, {
        scheduled_at: scheduledAt.toISOString(),
        duration_minutes: Number(data.get("duration")),
      });
    }
    if (confirmId)  await confirmConsultation(confirmId);
    if (cancelId)   await cancelConsultation(cancelId);
    if (completeId) await completeConsultation(completeId);
    state.consultations = await getConsultations().then(unwrap);
    renderConsultations();
    renderOverview(state.patients, state.consultations);
  } catch (err) {
    console.error("Consultation action failed:", err);
    if (scheduleId) {
      const status = document.querySelector(`[data-schedule-status="${CSS.escape(scheduleId)}"]`);
      if (status) status.textContent = err.message || "Could not send the proposed time.";
    }
    actionButton.disabled = false;
  }
}

// ── Tabs & load ─────────────────────────────────────────────

function unwrap(data) {
  return Array.isArray(data) ? data : (data.results ?? []);
}

function switchTab(tab) {
  document.querySelectorAll("[data-tab]").forEach(b =>
    b.classList.toggle("active", b.getAttribute("data-tab") === tab));
  document.querySelectorAll("[data-panel]").forEach(p =>
    p.classList.toggle("hidden", p.getAttribute("data-panel") !== tab));
  const title = document.getElementById("therapist-title");
  if (title) title.textContent = TAB_TITLES[tab] || "Dashboard";

  if (tab === "programmes") loadProgrammes();
  if (tab === "consultations") renderConsultations();
  if (tab === "messaging") loadMessaging();
  if (tab === "triage") loadTriage();
}

function triageRecordedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { dateStyle: "medium" });
}

function triageMetric(label, value, detail, modifier = "") {
  return `
    <div class="triage-evidence-metric ${modifier}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>`;
}

function renderTriageEvidence(patient) {
  const summary = patient.review_summary || {};
  const pain = summary.pain;
  const quality = summary.movement_quality;
  const recovery = summary.recovery;
  const recoveryLabels = {
    better: "Feeling better",
    same: "About the same",
    worse: "Feeling worse",
    unsure: "Not sure",
  };
  const painDetail = !pain
    ? "No check-ins recorded"
    : pain.trend === "rising"
      ? `Up ${pain.change} from previous${pain.location ? ` · ${pain.location}` : ""}`
      : pain.trend === "falling"
        ? `Down ${Math.abs(pain.change)} from previous${pain.location ? ` · ${pain.location}` : ""}`
        : pain.trend === "unchanged"
          ? `Unchanged from previous${pain.location ? ` · ${pain.location}` : ""}`
          : `First recorded check-in${pain.location ? ` · ${pain.location}` : ""}`;
  const qualityDetail = !quality
    ? "No camera score recorded"
    : quality.trend === "declining"
      ? `${quality.exercise} · down ${Math.abs(quality.change)} across ${quality.comparable_sessions} comparable sessions`
      : quality.trend === "improving"
        ? `${quality.exercise} · up ${quality.change} across ${quality.comparable_sessions} comparable sessions`
        : quality.trend === "stable"
          ? `${quality.exercise} · stable across ${quality.comparable_sessions} comparable sessions`
          : `${quality.exercise} · first comparable measurement`;
  const recoveryDetail = !recovery
    ? "No recovery reports recorded"
    : recovery.worse_count
      ? `${recovery.worse_count} worse report${recovery.worse_count === 1 ? "" : "s"} in ${recovery.observations} check-ins`
      : `${recovery.observations} recent recovery check-in${recovery.observations === 1 ? "" : "s"}`;
  const signals = Array.isArray(summary.signals) ? summary.signals : [];
  const statusClass = summary.evidence_status === "recorded_concerns"
    ? "has-concerns"
    : summary.evidence_status === "limited_data"
      ? "has-limited-data"
      : "has-no-worsening";
  const statusLabel = summary.evidence_status === "recorded_concerns"
    ? signals.length && signals.every(signal => signal.event_scope === "historical_safety_check")
      ? `${summary.concern_count} recorded safety event${summary.concern_count === 1 ? "" : "s"}`
      : `${summary.concern_count} recorded concern${summary.concern_count === 1 ? "" : "s"}`
    : summary.evidence_status === "limited_data"
      ? "Limited recorded data"
      : "No worsening signal recorded";
  const signalMarkup = signals.length
    ? `<ul class="triage-signal-list">${signals.map(signal => {
        const recorded = triageRecordedDate(signal.recorded_at);
        return `
          <li class="triage-signal is-${escapeHtml(signal.severity || "attention")}">
            <span class="triage-signal-icon" aria-hidden="true">${signal.severity === "high" ? "!" : "↗"}</span>
            <span>
              <strong>${escapeHtml(signal.label)}</strong>
              <small>${escapeHtml(signal.detail)}${recorded ? ` Recorded ${escapeHtml(recorded)}.` : ""}</small>
            </span>
          </li>`;
      }).join("")}</ul>`
    : `<div class="triage-evidence-empty ${statusClass}">
        <strong>${summary.evidence_status === "limited_data" ? "Reason needs confirming" : "Patient still requested a professional review"}</strong>
        <span>${summary.evidence_status === "limited_data"
          ? "No recent pain, recovery, validation-gated coaching-response, or safety record is available. Confirm the patient's reason directly before deciding."
          : "Available records do not currently show worsening pain, recovery, validated coaching response, or an open safety flag. This does not rule out a problem the patient has not recorded."}</span>
      </div>`;

  return `
    <section class="triage-evidence" aria-label="Recorded reason for physiotherapist review">
      <header>
        <div>
          <strong>Why review is requested</strong>
          <p>${escapeHtml(summary.request_reason || "The patient requested physiotherapist support.")}</p>
        </div>
        <span class="triage-evidence-status ${statusClass}">${escapeHtml(statusLabel)}</span>
      </header>
      <div class="triage-evidence-metrics">
        ${triageMetric(
          "Latest pain",
          pain ? `${pain.value}/10` : "Not recorded",
          painDetail,
          pain?.value >= 7 || pain?.trend === "rising" ? "needs-attention" : "",
        )}
        ${triageMetric(
          "Validated coaching response",
          quality ? `${quality.value}/100` : "Not recorded",
          qualityDetail,
          quality?.trend === "declining" || quality?.low_sessions >= 2 ? "needs-attention" : "",
        )}
        ${triageMetric(
          "Recovery",
          recovery ? (recoveryLabels[recovery.status] || "Recorded") : "Not recorded",
          recoveryDetail,
          recovery?.status === "worse" || recovery?.worse_count >= 2 ? "needs-attention" : "",
        )}
      </div>
      ${summary.patient_reported_background
        ? `<div class="triage-reported-background">
            <strong>Patient-reported background</strong>
            <span>${escapeHtml(summary.patient_reported_background)}</span>
          </div>`
        : ""}
      ${signalMarkup}
      <small class="triage-evidence-disclaimer">Recorded wellness indicators support clinician review; they are not a diagnosis.</small>
    </section>`;
}

function renderTriage() {
  const list = document.getElementById("triage-list");
  const badge = document.getElementById("triage-badge");
  if (badge) {
    badge.textContent = state.triage.length;
    badge.hidden = state.triage.length === 0;
  }
  if (!list) return;
  if (!state.triage.length) {
    list.innerHTML = `<div class="triage-empty"><span aria-hidden="true">✓</span><strong>Queue clear</strong><p>No patients are waiting to be linked.</p></div>`;
    return;
  }
  list.innerHTML = state.triage.map(patient => {
    const profileLabel = value => String(value || "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, letter => letter.toUpperCase());
    const goal = patient.custom_goal || goalLabel(patient.goal) || "Not provided";
    const requested = patient.requested_at
      ? new Date(patient.requested_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : "Recently";
    return `
      <article class="triage-card ${patient.review_summary?.high_concern_count ? "has-high-concern" : ""}">
        <div class="triage-card-content">
          <div class="triage-card-main">
            <div class="triage-avatar" aria-hidden="true">${escapeHtml(initials(patient.name))}</div>
            <div>
              <div class="triage-card-title"><strong>${escapeHtml(patient.name)}</strong><span>Awaiting clinician</span></div>
              ${patient.email ? `<small>${escapeHtml(patient.email)}</small>` : ""}
              <p>Goal: ${escapeHtml(goal)}</p>
              <div class="triage-meta">
                ${patient.mobility_status ? `<span>Mobility: ${escapeHtml(profileLabel(patient.mobility_status))}</span>` : ""}
                ${patient.activity_level ? `<span>Activity: ${escapeHtml(profileLabel(patient.activity_level))}</span>` : ""}
                ${patient.focus_side ? `<span>Focus: ${escapeHtml(profileLabel(patient.focus_side))}</span>` : ""}
              </div>
              <small>Requested ${requested}</small>
            </div>
          </div>
          ${renderTriageEvidence(patient)}
        </div>
        <div class="triage-card-actions">
          <div class="triage-action-buttons">
            <button class="button button-light button-small" type="button" data-triage-decline="${patient.id}">Decline request</button>
            <button class="button button-coral button-small" type="button" data-triage-claim="${patient.id}">Claim patient</button>
          </div>
          <p class="triage-card-error" data-triage-error hidden></p>
        </div>
      </article>`;
  }).join("");
}

async function loadTriage() {
  const list = document.getElementById("triage-list");
  if (list) list.innerHTML = `<p class="empty-state">Loading triage queue…</p>`;
  try {
    const [triageData, patientsData] = await Promise.all([
      getTriageQueue(),
      getPatients().catch(() => state.patients),
    ]);
    state.patients = unwrap(patientsData);
    state.triage = excludeRosterPatientsFromTriage(
      unwrap(triageData),
      state.patients,
    );
    renderTriage();
  } catch (error) {
    console.error("Triage load failed:", error);
    if (list) list.innerHTML = `<p class="empty-state">Could not load the triage queue.</p>`;
  }
}

async function claimTriageRequest(button) {
  const patientId = button.getAttribute("data-triage-claim");
  const errorMessage = button.closest(".triage-card")?.querySelector("[data-triage-error]");
  if (errorMessage) {
    errorMessage.hidden = true;
    errorMessage.textContent = "";
  }
  button.disabled = true;
  button.textContent = "Claiming…";
  try {
    await claimTriagePatient(patientId);
    state.triage = state.triage.filter(patient => String(patient.id) !== String(patientId));
    state.patients = await getPatients().then(unwrap);
    renderTriage();
    renderPatientTable(state.patients);
    renderStats(state.patients);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Claim patient";
    if (errorMessage) {
      errorMessage.textContent = error.message || "Could not claim this patient.";
      errorMessage.hidden = false;
    }
  }
}

async function declineTriageRequest(button) {
  const patientId = button.getAttribute("data-triage-decline");
  const card = button.closest(".triage-card");
  const patient = state.triage.find(item => String(item.id) === String(patientId));
  const patientName = patient?.name || "this patient";
  const nextStep = patient?.request_kind === "wellness_self_referral"
    ? "Their existing wellness plan will remain available, and they may request support again later."
    : "They will return to pathway selection and may request support again later.";
  const confirmed = window.confirm(
    `Decline the physiotherapist request from ${patientName}?\n\n` +
    `They will not be added to your roster. ${nextStep}`
  );
  if (!confirmed) return;

  const errorMessage = card?.querySelector("[data-triage-error]");
  const actionButtons = [...(card?.querySelectorAll("[data-triage-claim], [data-triage-decline]") || [])];
  if (errorMessage) {
    errorMessage.hidden = true;
    errorMessage.textContent = "";
  }
  actionButtons.forEach(action => { action.disabled = true; });
  button.textContent = "Declining…";

  try {
    await declineTriagePatient(patientId);
    state.triage = state.triage.filter(item => String(item.id) !== String(patientId));
    renderTriage();
  } catch (error) {
    actionButtons.forEach(action => { action.disabled = false; });
    button.textContent = "Decline request";
    if (errorMessage) {
      errorMessage.textContent = error.message || "Could not decline this request.";
      errorMessage.hidden = false;
    }
  }
}

// ── Messaging inbox ─────────────────────────────────────────

let activeConversation = null;
const AI_CONVERSATION_ID = "physiovision-ai";
const AI_WELCOME_MESSAGE = "Hello. I’m your PhysioVision AI workspace. I can review your roster, look up patient progress, prepare drafts and run clinician-approved actions. Type “help” for every command; clinical decisions remain yours.";
let activeAiSessionId = null;
let aiSessions = [];
let messagingPatientThreads = [];
let aiConversationMessages = [{ sender: "assistant", body: AI_WELCOME_MESSAGE }];

async function loadMessaging() {
  const list = document.getElementById("messaging-list");
  renderMessagingList(messagingPatientThreads);
  const [threadResult, sessionResult] = await Promise.allSettled([
    getCareMessageThreads(),
    getClinicianAiSessions(),
  ]);
  if (threadResult.status === "fulfilled") {
    const threads = threadResult.value;
    messagingPatientThreads = Array.isArray(threads) ? threads : threads.results ?? [];
    updateMessagingBadge(messagingPatientThreads);
  } else {
    console.error("Messaging load failed:", threadResult.reason);
  }
  if (sessionResult.status === "fulfilled") {
    const sessions = sessionResult.value;
    aiSessions = Array.isArray(sessions) ? sessions : sessions.results ?? [];
  } else {
    console.error("AI session history load failed:", sessionResult.reason);
  }
  renderMessagingList(messagingPatientThreads);
  if (threadResult.status === "rejected" && list) {
    list.insertAdjacentHTML(
      "beforeend",
      `<p class="messaging-list-empty">Could not load patient conversations.</p>`,
    );
  }
  if (sessionResult.status === "rejected" && list) {
    list.querySelector(".ai-session-list")?.insertAdjacentHTML(
      "beforeend",
      `<p class="messaging-list-empty">Could not load previous AI sessions.</p>`,
    );
  }
}

async function refreshAiSessionList() {
  try {
    const result = await getClinicianAiSessions();
    aiSessions = Array.isArray(result) ? result : result.results ?? [];
    renderMessagingList(messagingPatientThreads);
  } catch (error) {
    console.error("AI session history refresh failed:", error);
  }
}

function updateMessagingBadge(threads) {
  const total = threads.reduce((sum, t) => sum + (t.unread || 0), 0);
  const badge = document.getElementById("messaging-badge");
  if (!badge) return;
  badge.textContent = total;
  badge.hidden = total === 0;
}

function renderMessagingList(threads) {
  const list = document.getElementById("messaging-list");
  if (!list) return;
  const aiActive = activeConversation === AI_CONVERSATION_ID ? " is-active" : "";
  const assistant = `
    <button type="button" class="conversation-item conversation-item-ai${aiActive}" data-ai-conversation>
      <span class="conversation-top">
        <span class="conversation-ai-title"><span class="conversation-ai-mark" aria-hidden="true">✦</span><strong>PhysioVision AI</strong></span>
        <span class="conversation-pinned">Pinned</span>
      </span>
      <span class="conversation-preview">Clinical thinking and drafting workspace</span>
    </button>
    <div class="ai-session-history">
      <div class="ai-session-history-head">
        <strong>Previous AI sessions</strong>
        <button type="button" data-new-ai-session>＋ New session</button>
      </div>
      <div class="ai-session-list">
        ${aiSessions.length ? aiSessions.map(session => {
          const active = (
            activeConversation === AI_CONVERSATION_ID
            && String(activeAiSessionId) === String(session.id)
          ) ? " is-active" : "";
          const when = new Date(session.updated_at).toLocaleString([], {
            dateStyle: "medium",
            timeStyle: "short",
          });
          const plan = session.contains_plan
            ? `<span class="ai-session-plan-badge">Plan</span>`
            : "";
          return `
            <button type="button" class="ai-session-item${active}" data-ai-session="${session.id}">
              <span class="ai-session-title"><strong>${escapeHtml(session.title)}</strong>${plan}</span>
              <span class="conversation-preview">${escapeHtml(session.preview || "Saved conversation")}</span>
              <span class="conversation-when">${when} · ${session.message_count} ${session.message_count === 1 ? "message" : "messages"}</span>
            </button>`;
        }).join("") : `<p class="messaging-list-empty">No previous AI sessions yet.</p>`}
      </div>
    </div>
    <div class="messaging-list-section-label">Patient messages</div>`;
  const patientThreads = threads.map(t => {
    const preview = t.last_sender === "clinician" ? `You: ${t.last_body}` : t.last_body;
    const when = new Date(t.last_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    const unread = t.unread ? `<span class="conversation-unread">${t.unread}</span>` : "";
    const active = activeConversation === t.patient ? " is-active" : "";
    return `
      <button type="button" class="conversation-item${active}" data-conversation="${t.patient}">
        <span class="conversation-top">
          <strong>${escapeHtml(t.patient_name)}</strong>${unread}
        </span>
        <span class="conversation-preview">${escapeHtml(preview)}</span>
        <span class="conversation-when">${when}</span>
      </button>`;
  }).join("");
  const empty = threads.length
    ? ""
    : `<p class="messaging-list-empty">No patient messages yet.</p>`;
  list.innerHTML = assistant + empty + patientThreads;
}

function aiMessageRows() {
  const helpContent = `
    <div class="clinical-ai-help">
      <section><h4>Your roster</h4>
        <button type="button" data-ai-prompt="my patients"><code>my patients</code><span>Roster overview</span></button>
        <button type="button" data-ai-prompt="who needs review"><code>who needs review</code><span>Open escalations</span></button>
        <button type="button" data-ai-prompt="resolve Sarah"><code>resolve [name]</code><span>Clear a patient’s escalations</span></button>
        <button type="button" data-ai-prompt="today"><code>today</code><span>Consultations and new flags</span></button>
      </section>
      <section><h4>Patient lookups</h4>
        <button type="button" data-ai-prompt="show Sarah progress"><code>show [name] progress</code><span>Progress summary</span></button>
        <button type="button" data-ai-prompt="pain Sarah"><code>pain [name]</code><span>Recent pain history</span></button>
        <button type="button" data-ai-prompt="adherence Sarah"><code>adherence [name]</code><span>Programme adherence</span></button>
        <button type="button" data-ai-prompt="sessions Sarah"><code>sessions [name]</code><span>Recent exercise sessions</span></button>
      </section>
      <section><h4>Drafting and scheduling</h4>
        <button type="button" data-ai-prompt="draft note for Sarah"><code>draft note for [name]</code><span>Clinical note from latest session</span></button>
        <button type="button" data-ai-prompt="draft message for Sarah"><code>draft message for [name]</code><span>Encouraging patient message</span></button>
        <button type="button" data-ai-prompt="book Sarah Thursday 3pm"><code>book [name] [when]</code><span>Request a consultation</span></button>
      </section>
      <section><h4>Actions</h4>
        <button type="button" data-ai-prompt="send message to Sarah"><code>send message to [name]</code><span>Email an encouragement</span></button>
        <button type="button" data-ai-prompt="confirm Sarah"><code>confirm [name]</code><span>Confirm a consultation</span></button>
        <button type="button" data-ai-prompt="assign Half Squats to Sarah"><code>assign [exercise] to [name]</code><span>Prescribe one exercise</span></button>
      </section>
      <section><h4>AI programme builder</h4>
        <button type="button" data-ai-prompt="build a plan for Sarah"><code>build a plan for [name]</code><span>Create an editable draft</span></button>
        <button type="button" data-ai-prompt="revise Sarah reduce the intensity"><code>revise [name] [change]</code><span>Refine the draft</span></button>
        <button type="button" data-ai-prompt="summary"><code>summary</code><span>Whole-roster overview</span></button>
      </section>
    </div>`;
  const planContent = (plan, message, messageIndex) => {
    const exercises = Array.isArray(plan?.exercises) ? plan.exercises : [];
    const stages = Array.isArray(plan?.stages) ? plan.stages : [];
    if (plan?.assigned) {
      const assignedCount = Number(plan.assigned.exercise_count || exercises.length);
      return `
        <article class="clinical-plan-card clinical-plan-card-assigned">
          <header>
            <div><span>Assigned programme</span><h4>${escapeHtml(plan.patient_name || "Patient")}</h4></div>
            <span class="clinical-plan-draft-badge is-assigned">Sent to patient</span>
          </header>
          <div class="clinical-plan-assigned-summary">
            <strong>${escapeHtml(plan.assigned.stage_label || "Clinician-reviewed programme")}</strong>
            <p>${escapeHtml(assignedCount)} ${assignedCount === 1 ? "activity" : "activities"} assigned. The programme is available on the patient home page.</p>
          </div>
        </article>`;
    }
    const formKey = message?.id || messageIndex;
    const canAssign = Boolean(plan?.draft_id);
    return `
      <form class="clinical-plan-card clinical-plan-editor" data-ai-plan-form data-message-index="${messageIndex}" data-draft-id="${escapeHtml(plan.draft_id || "")}" data-message-id="${escapeHtml(message?.id || "")}">
        <header>
          <div><span>AI programme draft</span><h4>${escapeHtml(plan.patient_name || "Patient")}</h4></div>
          <span class="clinical-plan-draft-badge">Clinician review required</span>
        </header>
        ${plan.clinical_context ? `
          <div class="clinical-plan-context">
            <strong>Clinical context considered</strong>
            <p>${escapeHtml(plan.clinical_context)}</p>
          </div>` : ""}
        ${plan.summary ? `<p class="clinical-plan-summary">${escapeHtml(plan.summary)}</p>` : ""}
        <div class="clinical-plan-stage-field">
          <label for="clinical-plan-stage-${escapeHtml(formKey)}">Rehabilitation stage</label>
          <select id="clinical-plan-stage-${escapeHtml(formKey)}" name="stage" required>
            <option value="">Choose a stage…</option>
            ${stages.map(stage => `<option value="${escapeHtml(stage.value)}">${escapeHtml(stage.label)}</option>`).join("")}
          </select>
          <small>The physiotherapist—not the AI—selects the appropriate stage.</small>
        </div>
        <fieldset class="clinical-plan-exercises">
          <legend>Activities and dosage</legend>
          <p class="clinical-plan-editor-help">Untick an activity to leave it out. Adjust the AI-suggested dosage before assigning.</p>
          <div class="clinical-plan-row clinical-plan-row-head"><span>Include activity</span><span>Sets</span><span>Repetitions</span><span>Days/week</span></div>
          ${exercises.map(exercise => `
            <div class="clinical-plan-row clinical-plan-edit-row${exercise.available ? "" : " is-unavailable"}" data-plan-exercise-row data-exercise-id="${escapeHtml(exercise.id)}" data-hold-seconds="${escapeHtml(exercise.hold_seconds ?? "")}">
              <label class="clinical-plan-activity-choice">
                <input type="checkbox" name="included-exercise" value="${escapeHtml(exercise.id)}" ${exercise.available ? "checked" : "disabled"}>
                <span><strong>${escapeHtml(exercise.name)}</strong><small>${exercise.available ? "AI suggested" : "Unavailable in reviewed catalogue"}</small></span>
              </label>
              <label><span class="sr-only">Sets for ${escapeHtml(exercise.name)}</span><input class="clinical-plan-dose-input" data-dose="sets" type="number" min="1" max="10" value="${escapeHtml(exercise.sets ?? 1)}" required ${exercise.available ? "" : "disabled"}></label>
              <label><span class="sr-only">Repetitions for ${escapeHtml(exercise.name)}</span><input class="clinical-plan-dose-input" data-dose="reps" type="number" min="1" max="50" value="${escapeHtml(exercise.reps ?? 6)}" required ${exercise.available ? "" : "disabled"}></label>
              <label><span class="sr-only">Days per week for ${escapeHtml(exercise.name)}</span><input class="clinical-plan-dose-input" data-dose="days" type="number" min="1" max="7" value="${escapeHtml(exercise.days_per_week ?? 3)}" required ${exercise.available ? "" : "disabled"}></label>
            </div>`).join("")}
        </fieldset>
        <label class="clinical-plan-approval">
          <input type="checkbox" name="clinical-review-confirmed" required>
          <span>I have reviewed the stage, selected activities and dosage. I understand this replaces the patient’s current active programme.</span>
        </label>
        ${canAssign ? "" : `<p class="clinical-plan-inline-error">This older saved response is read-only. Build or revise the plan to create a current editable draft.</p>`}
        <p class="clinical-plan-form-status" data-plan-form-status role="status"></p>
        <footer>
          <button type="button" class="button button-light button-small" data-ai-fill="revise ${escapeHtml(plan.patient_first_name || "patient")} ">Revise with AI</button>
          <button type="submit" class="button button-coral button-small" ${canAssign ? "" : "disabled"}>Assign and send to patient</button>
        </footer>
      </form>`;
  };
  return aiConversationMessages.map((message, messageIndex) => `
    <div class="clinical-ai-message clinical-ai-message-${message.sender}">
      <span>${message.sender === "user" ? "You" : "PhysioVision AI"}</span>
      ${message.command === "help"
        ? helpContent
        : ["build_plan", "revise_plan"].includes(message.command) && message.data
          ? planContent(message.data, message, messageIndex)
          : message.sender === "assistant"
            ? formatClinicalAssistantText(message.body)
            : `<p>${escapeHtml(message.body)}</p>`}
    </div>`).join("");
}

function currentAiSession() {
  return aiSessions.find(session => String(session.id) === String(activeAiSessionId)) || null;
}

function showClinicalAssistant() {
  activeConversation = AI_CONVERSATION_ID;
  document.querySelectorAll(".conversation-item").forEach(el =>
    el.classList.toggle("is-active", el.hasAttribute("data-ai-conversation")));
  document.querySelectorAll("[data-ai-session]").forEach(el =>
    el.classList.toggle(
      "is-active",
      String(el.getAttribute("data-ai-session")) === String(activeAiSessionId),
    ));
  const panel = document.getElementById("messaging-conversation");
  if (!panel) return;
  const savedSession = currentAiSession();
  panel.innerHTML = `
    <div class="conversation-head clinical-ai-head">
      <div>
        <strong>${escapeHtml(savedSession?.title || "New AI session")}</strong>
        <span>PhysioVision AI · private workspace · not visible to patients</span>
      </div>
      <div class="clinical-ai-head-actions">
        ${activeAiSessionId ? `<span class="clinical-ai-label">Saved session</span>` : `<span class="clinical-ai-label">New session</span>`}
        <button type="button" class="button button-light button-small" data-new-ai-session>＋ New AI session</button>
      </div>
    </div>
    <div class="clinical-ai-notice">
      AI can make mistakes. Verify its output against patient records and use your clinical judgement.
    </div>
    <div class="clinical-ai-prompts" aria-label="Suggested assistant commands">
      <button type="button" data-ai-prompt="my patients">My patients</button>
      <button type="button" data-ai-prompt="who needs review">Needs review</button>
      <button type="button" data-ai-prompt="today">Today</button>
      <button type="button" data-ai-prompt="help">All commands</button>
    </div>
    <div class="clinical-ai-thread" id="clinical-ai-thread" role="log" aria-live="polite">${aiMessageRows()}</div>
    <p class="clinical-ai-status" id="clinical-ai-status" role="status"></p>
    <form class="detail-messages-form clinical-ai-form" id="clinical-ai-form">
      <textarea id="clinical-ai-input" rows="2" maxlength="2000" placeholder="Ask the assistant…" required></textarea>
      <button class="button button-coral button-small" type="submit">Send</button>
    </form>`;
  const thread = panel.querySelector("#clinical-ai-thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
  panel.querySelector("#clinical-ai-form")?.addEventListener("submit", handleClinicalAssistantMessage);
  panel.querySelectorAll("[data-ai-plan-form]").forEach(form =>
    form.addEventListener("submit", handleAssignAiProgramme));
}

async function handleAssignAiProgramme(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("[data-plan-form-status]");
  const button = form.querySelector('button[type="submit"]');
  const selectedRows = [...form.querySelectorAll("[data-plan-exercise-row]")]
    .filter(row => row.querySelector('input[name="included-exercise"]')?.checked);

  if (!selectedRows.length) {
    if (status) status.textContent = "Include at least one activity before assigning.";
    return;
  }

  const exercises = selectedRows.map(row => {
    const holdValue = row.getAttribute("data-hold-seconds");
    return {
      exercise: row.getAttribute("data-exercise-id"),
      sets: Number(row.querySelector('[data-dose="sets"]').value),
      reps: Number(row.querySelector('[data-dose="reps"]').value),
      days_per_week: Number(row.querySelector('[data-dose="days"]').value),
      hold_seconds: holdValue === "" ? null : Number(holdValue),
    };
  });
  const messageIndex = Number(form.getAttribute("data-message-index"));
  const message = aiConversationMessages[messageIndex];
  const payload = {
    draft: form.getAttribute("data-draft-id"),
    stage: form.elements.stage.value,
    exercises,
  };
  const messageId = form.getAttribute("data-message-id");
  if (messageId) payload.message_id = messageId;

  button.disabled = true;
  if (status) status.textContent = "Assigning the reviewed programme and notifying the patient…";
  try {
    const result = await assignAiDraftProgramme(payload);
    if (message?.data) message.data.assigned = result.assigned;
    [state.prescriptions, state.patients] = await Promise.all([
      getPrescriptions().then(unwrap),
      getPatients().then(unwrap),
    ]);
    renderProgrammes();
    renderPatientTable(state.patients);
    await refreshAiSessionList();
    if (activeConversation === AI_CONVERSATION_ID) showClinicalAssistant();
  } catch (error) {
    if (status) status.textContent = error.message || "Could not assign this programme.";
    button.disabled = false;
  }
}

function startNewClinicalAssistantSession() {
  activeConversation = AI_CONVERSATION_ID;
  activeAiSessionId = null;
  aiConversationMessages = [{ sender: "assistant", body: AI_WELCOME_MESSAGE }];
  renderMessagingList(messagingPatientThreads);
  showClinicalAssistant();
  document.getElementById("clinical-ai-input")?.focus();
}

async function openClinicalAssistantSession(sessionId) {
  activeConversation = AI_CONVERSATION_ID;
  activeAiSessionId = sessionId;
  const panel = document.getElementById("messaging-conversation");
  if (panel) panel.innerHTML = `<p class="empty-state">Loading saved AI session…</p>`;
  renderMessagingList(messagingPatientThreads);
  try {
    const session = await getClinicianAiSession(sessionId);
    const index = aiSessions.findIndex(item => String(item.id) === String(session.id));
    if (index >= 0) aiSessions[index] = { ...aiSessions[index], ...session };
    aiConversationMessages = (session.messages || []).map(message => ({
      id: message.id,
      sender: message.role,
      body: message.body,
      command: message.command || null,
      data: message.data && Object.keys(message.data).length ? message.data : null,
    }));
    if (!aiConversationMessages.length) {
      aiConversationMessages = [{ sender: "assistant", body: AI_WELCOME_MESSAGE }];
    }
    renderMessagingList(messagingPatientThreads);
    showClinicalAssistant();
  } catch (error) {
    console.error("Saved AI session load failed:", error);
    activeAiSessionId = null;
    if (panel) {
      panel.innerHTML = `
        <p class="empty-state">Could not load that saved AI session.</p>
        <button type="button" class="button button-light button-small" data-new-ai-session>Start a new AI session</button>`;
    }
    renderMessagingList(messagingPatientThreads);
  }
}

function openDefaultClinicalAssistant() {
  if (activeAiSessionId) {
    showClinicalAssistant();
  } else if (aiSessions.length) {
    openClinicalAssistantSession(aiSessions[0].id);
  } else {
    startNewClinicalAssistantSession();
  }
}

async function handleClinicalAssistantMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector("#clinical-ai-input");
  const button = form.querySelector("button");
  const status = document.getElementById("clinical-ai-status");
  const message = input.value.trim();
  if (!message) return;
  const history = aiConversationMessages
    .filter(item => ["user", "assistant"].includes(item.sender))
    .slice(-8)
    .map(item => ({ role: item.sender === "user" ? "user" : "assistant", content: item.body }));
  aiConversationMessages.push({ sender: "user", body: message });
  input.value = "";
  button.disabled = true;
  if (status) status.textContent = "PhysioVision AI is thinking…";
  const thread = document.getElementById("clinical-ai-thread");
  if (thread) {
    thread.innerHTML = aiMessageRows();
    thread.scrollTop = thread.scrollHeight;
  }
  try {
    const result = await sendAgentMessage(message, {}, history, activeAiSessionId);
    activeAiSessionId = result.session_id || activeAiSessionId;
    aiConversationMessages.push({
      id: result.message_id || null,
      sender: "assistant",
      body: result.reply,
      command: result.command || null,
      data: result.data || null,
    });
  } catch (error) {
    activeAiSessionId = error.data?.session_id || activeAiSessionId;
    aiConversationMessages.push({ sender: "error", body: error.message || "The assistant is unavailable." });
  } finally {
    await refreshAiSessionList();
    if (activeConversation === AI_CONVERSATION_ID) showClinicalAssistant();
  }
}

async function openConversation(patientId) {
  activeConversation = patientId;
  document.querySelectorAll(".conversation-item").forEach(el =>
    el.classList.toggle("is-active", el.getAttribute("data-conversation") === String(patientId)));
  const panel = document.getElementById("messaging-conversation");
  if (!panel) return;
  panel.innerHTML = `<p class="empty-state">Loading…</p>`;
  try {
    const data = await getCareMessages(patientId);
    const messages = Array.isArray(data) ? data : data.results ?? [];
    const rosterName = state.patients.find(p => String(p.id) === String(patientId))?.full_name;
    const name = rosterName
      || (messages[0]?.sender === "patient" ? messages[0].sender_name : "Patient");
    const emptyThread = `<p class="empty-state">No messages yet — say hello.</p>`;
    panel.innerHTML = `
      <div class="conversation-head"><strong>${escapeHtml(name)}</strong></div>
      <div class="detail-messages-thread" id="conversation-thread">${messages.length ? careMessageRows(messages) : emptyThread}</div>
      <form class="detail-messages-form" id="conversation-form">
        <textarea id="conversation-input" rows="2" maxlength="1000" placeholder="Write a reply…"></textarea>
        <button class="button button-coral button-small" type="submit">Send</button>
      </form>`;
    const thread = panel.querySelector("#conversation-thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
    panel.querySelector("#conversation-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = panel.querySelector("#conversation-input");
      const body = input.value.trim();
      if (!body) return;
      e.target.querySelector("button").disabled = true;
      try {
        await sendCareMessage(body, patientId);
        input.value = "";
        await openConversation(patientId);
        loadMessaging();
      } catch (err) {
        console.error("Reply failed:", err);
        e.target.querySelector("button").disabled = false;
      }
    });
    loadMessaging();  // refresh unread counts now this thread is read
  } catch (err) {
    console.error("Conversation load failed:", err);
    panel.innerHTML = `<p class="empty-state">Could not load this conversation.</p>`;
  }
}

// Physio-initiated conversation: pick any roster patient to start a thread.
function showNewConversationPicker() {
  activeConversation = null;
  document.querySelectorAll(".conversation-item.is-active")
    .forEach(el => el.classList.remove("is-active"));
  const panel = document.getElementById("messaging-conversation");
  if (!panel) return;
  if (!state.patients.length) {
    panel.innerHTML = `<p class="empty-state">No patients in your roster yet.</p>`;
    return;
  }
  panel.innerHTML = `
    <div class="conversation-head"><strong>New message</strong><span>Choose a patient to message</span></div>
    <div class="new-conversation-list">
      ${state.patients.map(p => `
        <button type="button" class="conversation-item" data-new-conversation="${p.id}">
          <span class="conversation-top"><strong>${escapeHtml(p.full_name || "Patient")}</strong></span>
          <span class="conversation-preview">${escapeHtml(goalLabel(p.goal))}</span>
        </button>`).join("")}
    </div>`;
}

async function loadProgrammes() {
  const exerciseSelect = document.getElementById("rx-exercise");
  try {
    if (!state.exercises.length) state.exercises = await getExercises().then(unwrap);
    state.prescriptions = await getPrescriptions().then(unwrap);
    renderProgrammes();
  } catch (err) {
    console.error("Programmes load failed:", err);
    if (exerciseSelect) {
      exerciseSelect.innerHTML = `<option value="">Could not load exercises</option>`;
      exerciseSelect.disabled = true;
    }
    const status = document.getElementById("rx-status");
    if (status) status.textContent = "The exercise catalogue could not be loaded. Refresh and try again.";
  }
}

function renderClinicianInfo(me) {
  const name = `${me.first_name} ${me.last_name}`.trim() || "Clinician";
  const nameEl   = document.getElementById("clinician-name");
  const avatarEl = document.getElementById("clinician-avatar");
  if (nameEl)   nameEl.textContent   = name;
  if (avatarEl) avatarEl.textContent = initials(name);
  const floatingAiLauncher = document.getElementById("agentChatLauncher");
  const floatingAiPanel = document.getElementById("agentChatPanel");
  if (floatingAiLauncher) floatingAiLauncher.hidden = true;
  if (floatingAiPanel) floatingAiPanel.hidden = true;

}

function setLoading(on) {
  document.querySelector(".therapist-content")?.classList.toggle("is-loading", on);
}

async function loadDashboard() {
  if (!isLoggedIn()) return;

  const dateEl = document.getElementById("dashboard-date");
  if (dateEl) dateEl.textContent = formatDate(new Date());

  setLoading(true);
  try {
    const [me, patientsData, consultData, triageData] = await Promise.all([
      getMe(), getPatients(), getConsultations().catch(() => []), getTriageQueue().catch(() => []),
    ]);

    if (me.role !== "clinician") {
      document.getElementById("patient-table-body").innerHTML =
        `<p class="empty-state">Clinician access only.</p>`;
      return;
    }

    renderClinicianInfo(me);
    state.patients      = unwrap(patientsData);
    state.consultations = unwrap(consultData);
    state.triage        = excludeRosterPatientsFromTriage(
      unwrap(triageData),
      state.patients,
    );

    renderStats(state.patients);
    renderOverview(state.patients, state.consultations);
    renderPatientTable(state.patients);
    renderTriage();
    // Surface the unread-messages badge without opening the tab.
    getCareMessageThreads()
      .then(t => updateMessagingBadge(Array.isArray(t) ? t : t.results ?? []))
      .catch(() => {});
  } catch (err) {
    const body = document.getElementById("patient-table-body");
    if (body) body.innerHTML = `<p class="empty-state">Could not load patients. Please try again.</p>`;
    console.error("Dashboard load failed:", err);
  } finally {
    setLoading(false);
  }
}

// ── Event wiring (delegated; elements live inside the modal) ──

document.addEventListener("click", (e) => {
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn) { switchTab(tabBtn.getAttribute("data-tab")); return; }

  if (e.target.closest("#messaging-new")) {
    showNewConversationPicker();
    return;
  }

  if (e.target.closest("#triage-refresh")) {
    loadTriage();
    return;
  }

  const triageClaim = e.target.closest("[data-triage-claim]");
  if (triageClaim) {
    claimTriageRequest(triageClaim);
    return;
  }

  const initiatePatient = e.target.closest("[data-initiate-patient]");
  if (initiatePatient) {
    const select = document.getElementById("consult-initiate-patient");
    if (select) select.value = initiatePatient.getAttribute("data-initiate-patient");
    document.getElementById("consult-initiate-date")?.focus();
    return;
  }

  const triageDecline = e.target.closest("[data-triage-decline]");
  if (triageDecline) {
    declineTriageRequest(triageDecline);
    return;
  }

  if (e.target.closest("[data-ai-conversation]")) {
    openDefaultClinicalAssistant();
    return;
  }

  if (e.target.closest("[data-new-ai-session]")) {
    startNewClinicalAssistantSession();
    return;
  }

  const aiSession = e.target.closest("[data-ai-session]");
  if (aiSession) {
    openClinicalAssistantSession(aiSession.getAttribute("data-ai-session"));
    return;
  }

  const aiPrompt = e.target.closest("[data-ai-prompt]");
  if (aiPrompt) {
    const input = document.getElementById("clinical-ai-input");
    if (input) {
      input.value = aiPrompt.getAttribute("data-ai-prompt");
      if (aiPrompt.closest(".clinical-ai-help")) {
        input.focus();
      } else {
        input.form?.requestSubmit();
      }
    }
    return;
  }

  const aiFill = e.target.closest("[data-ai-fill]");
  if (aiFill) {
    const input = document.getElementById("clinical-ai-input");
    if (input) {
      input.value = aiFill.getAttribute("data-ai-fill");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    return;
  }

  const newConversation = e.target.closest("[data-new-conversation]");
  if (newConversation) {
    openConversation(newConversation.getAttribute("data-new-conversation"));
    return;
  }

  const conversation = e.target.closest("[data-conversation]");
  if (conversation) {
    openConversation(conversation.getAttribute("data-conversation"));
    return;
  }

  const row = e.target.closest("[data-patient-id]");
  if (row && !e.target.closest(".status-pill")) {
    const inOverview = row.closest('[data-panel="overview"]');
    if (inOverview) switchTab("patients");
    showPatientDetail(row.getAttribute("data-patient-id"));
    return;
  }

  handleConsultAction(e);
});

document.addEventListener("input", (e) => {
  if (e.target.id === "patient-search") renderPatientTable(state.patients);
});

document.addEventListener("change", (e) => {
  if (e.target.matches('input[name="included-exercise"]')) {
    const row = e.target.closest("[data-plan-exercise-row]");
    row?.classList.toggle("is-excluded", !e.target.checked);
    row?.querySelectorAll("[data-dose]").forEach(input => {
      input.disabled = !e.target.checked;
    });
    return;
  }
  if (["rx-filter-patient", "rx-filter-status", "rx-filter-completion"].includes(e.target.id)) {
    renderProgrammes();
  }
});

document.getElementById("rx-form")?.addEventListener("submit", submitPrescription);
document.getElementById("consult-initiate-form")?.addEventListener("submit", submitInitiatedConsultation);

window.pvLoadDashboard = loadDashboard;
