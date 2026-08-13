import {
  hasSavedProfile,
  loadProfile,
  saveProfile,
} from "./personalization.js?v=13";
import {
  evaluateWellnessScreening,
  WELLNESS_SCREENING_KEYS,
} from "./wellness-screening.js";
import {
  acceptWellnessPlan,
  confirmEmergencyContactVerification,
  generateWellnessPlan,
  isLoggedIn,
  patchMe,
  postWellnessScreening,
  startEmergencyContactVerification,
} from "./api.js?v=35";
import { getLocale, translateText } from "./i18n.js?v=39";

const GOAL_API_VALUES = Object.freeze({
  "Stronger knees": "stronger_knees",
  "Better balance": "better_balance",
  "Move with less stiffness": "less_stiffness",
  "Stay active": "stay_active",
  "Stronger hips": "stronger_hips",
  "Better shoulder movement": "shoulder_mobility",
  "Better ankle movement": "ankle_mobility",
  "Walk with confidence": "walking_confidence",
  "Other": "other",
});

const ACTIVITY_API_VALUES = Object.freeze({
  "Lightly active": "lightly_active",
  "Mostly seated": "mostly_seated",
  "Active most days": "active_most_days",
});

function localizableAiPlanSource(value, fallback) {
  const source = String(value ?? "").trim();
  const fallbackText = String(fallback ?? "").trim();
  if (!source) return fallbackText;
  if (getLocale() === "en-SG" || translateText(source) !== source) return source;
  return fallbackText;
}

const WELLNESS_DOSAGE_LABEL = "1 set of 6–10 repetitions";

(() => {
  const body = document.body;
  const header = document.querySelector(".site-header");
  const menuButton = document.querySelector(".menu-toggle");
  const mobileNav = document.querySelector(".mobile-nav");
  const modalShells = [...document.querySelectorAll(".modal-shell")];
  const planForm = document.getElementById("planForm");
  const profileForm = document.getElementById("profileForm");
  const planSteps = planForm ? [...planForm.querySelectorAll(".form-step")] : [];
  const progressBars = [...document.querySelectorAll(".modal-progress span")];
  const wellnessEligibleOutcome = document.getElementById("wellnessEligibleOutcome");
  const wellnessReviewOutcome = document.getElementById("wellnessReviewOutcome");
  const wellnessReviewReasons = document.getElementById("wellnessReviewReasons");
  const generatedWellnessPlan = document.getElementById("generatedWellnessPlan");
  const plannerRationale = document.getElementById("plannerRationale");
  const plannerAgentTrace = document.getElementById("plannerAgentTrace");
  const plannerRequestStatus = document.getElementById("plannerRequestStatus");
  const plannerAcceptStatus = document.getElementById("plannerAcceptStatus");
  const wellnessScreeningStatus = document.getElementById("wellnessScreeningStatus");
  const requestPlanDraft = document.getElementById("requestPlanDraft");
  const requestPlanRevision = document.getElementById("requestPlanRevision");
  const planRevisionRequest = document.getElementById("planRevisionRequest");
  const planCustomGoalField = document.getElementById("planCustomGoalField");
  const planCustomGoalInput = document.getElementById("planCustomGoal");
  const plannerMedicalHistoryField = document.getElementById(
    "plannerMedicalHistoryField"
  );
  const plannerMedicalHistory = document.getElementById(
    "plannerMedicalHistory"
  );
  const profileCustomGoalField = document.getElementById("profileCustomGoalField");
  const profileCustomGoalInput = document.getElementById("profileCustomGoal");
  const emergencyContactName = document.getElementById("emergencyContactName");
  const emergencyContactRelationship = document.getElementById(
    "emergencyContactRelationship"
  );
  const emergencyContactPhone = document.getElementById("emergencyContactPhone");
  const emergencyContactConsent = document.getElementById(
    "emergencyContactConsent"
  );
  const emergencyContactVerificationTitle = document.getElementById(
    "emergencyContactVerificationTitle"
  );
  const emergencyContactVerificationDetail = document.getElementById(
    "emergencyContactVerificationDetail"
  );
  const emergencyContactSendCode = document.getElementById(
    "emergencyContactSendCode"
  );
  const emergencyContactCodeEntry = document.getElementById(
    "emergencyContactCodeEntry"
  );
  const emergencyContactCode = document.getElementById("emergencyContactCode");
  const emergencyContactVerifyCode = document.getElementById(
    "emergencyContactVerifyCode"
  );
  const emergencyContactVerificationStatus = document.getElementById(
    "emergencyContactVerificationStatus"
  );
  let activeModal = null;
  let previousFocus = null;
  let planStep = 1;
  let activeWellnessPlan = null;
  let activePlanPreferences = null;
  let activePlanDraftToken = null;
  let authenticatedRole = null;

  window.addEventListener("physiovision:auth-role", (event) => {
    authenticatedRole = event.detail?.role ?? null;
  });

  function syncCustomGoalField(form, field, input) {
    if (!form || !field || !input) return;
    const selectedGoal = form.elements.namedItem("goal")?.value;
    const isOther = selectedGoal === "Other";
    field.hidden = !isOther;
    input.required = isOther;
    if (!isOther) input.setCustomValidity("");
  }

  function syncEmergencyContactRequirements() {
    if (
      !emergencyContactName
      || !emergencyContactRelationship
      || !emergencyContactPhone
      || !emergencyContactConsent
    ) return;
    const hasDetails = Boolean(
      emergencyContactName.value.trim()
      || emergencyContactRelationship.value
      || emergencyContactPhone.value.trim()
    );
    emergencyContactName.required = hasDetails;
    emergencyContactRelationship.required = hasDetails;
    emergencyContactPhone.required = hasDetails;
    emergencyContactConsent.required = hasDetails;

    const phone = emergencyContactPhone.value.trim();
    const digitCount = phone.replace(/\D/g, "").length;
    let phoneError = "";
    if (phone && !/^[+0-9() .-]+$/.test(phone)) {
      phoneError = "Use only numbers and common phone-number symbols.";
    } else if (phone && !phone.startsWith("+")) {
      phoneError =
        "Include the country code, for example +65 9123 4567.";
    } else if (phone && (digitCount < 8 || digitCount > 15)) {
      phoneError =
        "Enter a valid phone number containing 8 to 15 digits, including the country code when needed.";
    }
    emergencyContactPhone.setCustomValidity(phoneError);
  }

  function emergencyContactValuesFromForm() {
    return {
      emergencyContactName: emergencyContactName?.value.trim() ?? "",
      emergencyContactRelationship:
        emergencyContactRelationship?.value ?? "",
      emergencyContactPhone: emergencyContactPhone?.value.trim() ?? "",
      emergencyContactConsent: Boolean(emergencyContactConsent?.checked),
    };
  }

  function profileContactFromApi(apiProfile) {
    return {
      emergencyContactName: apiProfile.emergency_contact_name ?? "",
      emergencyContactRelationship:
        apiProfile.emergency_contact_relationship ?? "",
      emergencyContactPhone: apiProfile.emergency_contact_phone ?? "",
      emergencyContactConsent:
        apiProfile.emergency_contact_consent === true,
      emergencyContactVerifiedAt:
        apiProfile.emergency_contact_verified_at ?? null,
      emergencyContactAlertsReady:
        apiProfile.emergency_contact_alerts_ready === true,
    };
  }

  function renderEmergencyContactVerification(profile = loadProfile()) {
    if (
      !emergencyContactVerificationTitle
      || !emergencyContactVerificationDetail
      || !emergencyContactSendCode
    ) return;
    const hasContact = Boolean(
      profile.emergencyContactName
      && profile.emergencyContactPhone
      && profile.emergencyContactConsent
    );
    const verified = Boolean(profile.emergencyContactVerifiedAt);
    const alertsReady = profile.emergencyContactAlertsReady === true;
    if (!hasContact) {
      emergencyContactVerificationTitle.textContent =
        "Add contact details to enable verification";
      emergencyContactVerificationDetail.textContent =
        "Automatic fall alerts remain off until a complete contact is saved and verified.";
    } else if (alertsReady) {
      emergencyContactVerificationTitle.textContent =
        "Verified and ready for automatic alerts";
      emergencyContactVerificationDetail.textContent =
        "After a possible fall, no response can trigger an automated call to this contact.";
    } else if (verified) {
      emergencyContactVerificationTitle.textContent = "Phone number verified";
      emergencyContactVerificationDetail.textContent =
        "Automatic delivery is not active on this server yet. Configure the notification provider and alert worker.";
    } else {
      emergencyContactVerificationTitle.textContent =
        "Phone verification required";
      emergencyContactVerificationDetail.textContent =
        "Your contact must share the code spoken during the verification call before automatic fall alerts can call them.";
    }
    emergencyContactSendCode.textContent = verified
      ? "Send new code"
      : "Send verification code";
    emergencyContactSendCode.disabled = !hasContact || !isLoggedIn();
  }

  function renderEmergencyContactVerificationFromForm() {
    const cached = loadProfile();
    const formContact = emergencyContactValuesFromForm();
    const contactChanged = (
      cached.emergencyContactPhone !== formContact.emergencyContactPhone
      || !formContact.emergencyContactConsent
    );
    renderEmergencyContactVerification({
      ...cached,
      ...formContact,
      emergencyContactVerifiedAt: contactChanged
        ? null
        : cached.emergencyContactVerifiedAt,
      emergencyContactAlertsReady: contactChanged
        ? false
        : cached.emergencyContactAlertsReady,
    });
  }

  [
    emergencyContactName,
    emergencyContactPhone,
  ].forEach((field) => {
    field?.addEventListener("input", () => {
      syncEmergencyContactRequirements();
      renderEmergencyContactVerificationFromForm();
    });
  });
  [
    emergencyContactRelationship,
    emergencyContactConsent,
  ].forEach((field) => {
    field?.addEventListener("change", () => {
      syncEmergencyContactRequirements();
      renderEmergencyContactVerificationFromForm();
    });
  });

  planForm?.querySelectorAll('input[name="goal"]').forEach((input) => {
    input.addEventListener("change", () => {
      syncCustomGoalField(planForm, planCustomGoalField, planCustomGoalInput);
      if (input.value === "Other") planCustomGoalInput?.focus();
    });
  });
  profileForm?.elements.namedItem("goal")?.addEventListener("change", () => {
    syncCustomGoalField(
      profileForm,
      profileCustomGoalField,
      profileCustomGoalInput
    );
  });

  function syncPlannerMedicalHistoryField() {
    const hasRelevantHistory =
      planForm
        ?.querySelector('input[name="hasRelevantHistory"]:checked')
        ?.value === "true";
    if (plannerMedicalHistoryField) {
      plannerMedicalHistoryField.hidden = !hasRelevantHistory;
    }
    if (plannerMedicalHistory) {
      plannerMedicalHistory.disabled = !hasRelevantHistory;
      plannerMedicalHistory.required = hasRelevantHistory;
    }
  }

  planForm
    ?.querySelectorAll('input[name="hasRelevantHistory"]')
    .forEach((input) => {
      input.addEventListener("change", () => {
        syncPlannerMedicalHistoryField();
        if (input.value === "true" && input.checked) {
          plannerMedicalHistory?.focus();
        }
      });
    });

  const setHeaderState = () => {
    header?.classList.toggle("is-scrolled", window.scrollY > 80);
  };

  setHeaderState();
  window.addEventListener("scroll", setHeaderState, { passive: true });

  const closeMenu = () => {
    mobileNav?.classList.remove("is-open");
    menuButton?.setAttribute("aria-expanded", "false");
    menuButton?.setAttribute("aria-label", "Open navigation");
  };

  menuButton?.addEventListener("click", () => {
    const opening = !mobileNav?.classList.contains("is-open");
    mobileNav?.classList.toggle("is-open", opening);
    menuButton.setAttribute("aria-expanded", String(opening));
    menuButton.setAttribute("aria-label", opening ? "Close navigation" : "Open navigation");
  });

  mobileNav?.querySelectorAll("a, button").forEach((control) => {
    control.addEventListener("click", closeMenu);
  });

  const focusableSelector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;

    previousFocus = document.activeElement;
    activeModal = modal;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    body.classList.add("modal-open");

    if (id === "plan-modal") {
      const savedProfile = loadProfile();
      if (hasSavedProfile()) {
        fillFormFromProfile(planForm, savedProfile);
        fillWellnessScreening(planForm, savedProfile.wellnessScreening);
      }
      syncCustomGoalField(planForm, planCustomGoalField, planCustomGoalInput);
      syncPlannerMedicalHistoryField();
      // A replacement draft may use the accepted plan as context. Merely
      // opening or closing the planner never removes the current plan.
      activeWellnessPlan = savedProfile.wellnessPlan ?? null;
      activePlanPreferences = null;
      activePlanDraftToken = null;
      if (plannerRequestStatus) plannerRequestStatus.textContent = "";
      if (plannerAcceptStatus) plannerAcceptStatus.textContent = "";
      showPlanStep(1);
    } else if (id === "profile-modal") {
      fillFormFromProfile(profileForm, loadProfile());
      syncCustomGoalField(
        profileForm,
        profileCustomGoalField,
        profileCustomGoalInput
      );
      syncEmergencyContactRequirements();
      renderEmergencyContactVerification(profile);
    } else if (id === "therapist-view") {
      window.pvLoadDashboard?.();
    }

    if (id === "booking-modal") {
      window.dispatchEvent(new CustomEvent("physiovision:booking-opened"));
    }

    window.setTimeout(() => {
      modal.querySelector(focusableSelector)?.focus();
    }, 50);
  }

  function closeModal(modal = activeModal) {
    if (!modal) return;
    const wasBookingModal = modal.id === "booking-modal";
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    body.classList.remove("modal-open");
    activeModal = null;
    if (wasBookingModal) {
      window.dispatchEvent(new CustomEvent("physiovision:booking-closed"));
    }
    previousFocus?.focus?.();
  }

  document.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", () => {
      let modalId = button.dataset.open;
      const currentRole =
        authenticatedRole || document.body.dataset.authRole || null;
      const patientOnly =
        modalId === "plan-modal" ||
        modalId === "profile-modal" ||
        modalId === "booking-modal";
      const therapistOnly = modalId === "therapist-view";

      if (patientOnly && !isLoggedIn()) {
        document.getElementById("authTabLogin")?.click();
        modalId = "auth-modal";
      } else if (patientOnly && currentRole === "clinician") {
        modalId = "therapist-view";
      } else if (therapistOnly && !isLoggedIn()) {
        document.getElementById("authTabLogin")?.click();
        modalId = "auth-modal";
      } else if (therapistOnly && currentRole !== "clinician") {
        return;
      }

      openModal(modalId);
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach((control) => {
    control.addEventListener("click", () => {
      const shell = control.closest(".modal-shell");
      closeModal(shell);
    });
  });

  modalShells.forEach((shell) => {
    shell.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusable = [...shell.querySelectorAll(focusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (activeModal) closeModal();
      closeMenu();
    }
  });

  function showPlanStep(step) {
    planStep = Math.max(1, Math.min(step, planSteps.length));
    planSteps.forEach((panel) => {
      panel.classList.toggle("active", Number(panel.dataset.step) === planStep);
    });
    progressBars.forEach((bar, index) => {
      bar.classList.toggle("active", index < planStep);
    });

    const activeStep = planSteps.find(
      (panel) => Number(panel.dataset.step) === planStep
    );
    activeStep?.querySelector("input, button, select, textarea")?.focus();
  }

  function validatePlanStep(step) {
    const required = [...step.querySelectorAll("[required]")];
    const invalid = required.find((field) => !field.checkValidity());
    if (!invalid) return true;
    invalid.reportValidity();
    invalid.focus();
    return false;
  }

  function readWellnessScreening(formData) {
    return Object.fromEntries(
      WELLNESS_SCREENING_KEYS.map((key) => [
        key,
        formData.get(key) === "true",
      ])
    );
  }

  function renderWellnessOutcome(screening) {
    const eligible = screening.status === "eligible";
    wellnessEligibleOutcome.classList.toggle("hidden", !eligible);
    wellnessReviewOutcome.classList.toggle("hidden", eligible);
    if (!eligible) {
      wellnessReviewReasons.innerHTML = "";
      screening.reviewReasons.forEach((reason) => {
        const item = document.createElement("li");
        item.textContent = reason;
        wellnessReviewReasons.appendChild(item);
      });
    }
  }

  function renderWellnessPlan(plan, age) {
    activeWellnessPlan = plan;
    generatedWellnessPlan.innerHTML = "";
    plan.days.forEach((day, index) => {
      const row = document.createElement("div");
      row.className = "generated-day";

      const dayLabel = document.createElement("span");
      dayLabel.textContent = day.day;
      const detail = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = localizableAiPlanSource(
        day.title,
        day.exercises || `Session ${index + 1}`,
      );
      const exercises = document.createElement("small");
      exercises.textContent = day.exercises;
      const dosage = document.createElement("em");
      dosage.textContent = day.dosage || WELLNESS_DOSAGE_LABEL;

      detail.append(title, exercises);
      row.append(dayLabel, detail, dosage);
      generatedWellnessPlan.appendChild(row);
    });

    const summary = document.getElementById("planSummary");
    if (summary) {
      summary.textContent = localizableAiPlanSource(
        plan.summary,
        `A gradual plan focused on ${plan.goal ?? "Stay active"}.`,
      );
    }
    if (plannerRationale) {
      const rationaleFallbacks = [
        "The draft uses only reviewed exercises compatible with your answers and available equipment.",
        "Uses one set of 6–10 repetitions for each exercise to keep the starting dose manageable.",
        "Every session still requires your review, and you should stop if a movement causes pain or concerning symptoms.",
      ];
      plannerRationale.replaceChildren(
        ...(plan.rationale ?? []).map((reason, index) => {
          const item = document.createElement("p");
          item.textContent = localizableAiPlanSource(
            reason,
            rationaleFallbacks[index] ?? rationaleFallbacks[0],
          );
          return item;
        })
      );
    }
    if (plannerAgentTrace) {
      plannerAgentTrace.replaceChildren(
        ...(plan.agent_trace ?? []).map((event) => {
          const item = document.createElement("li");
          item.textContent = event;
          return item;
        })
      );
    }
  }

  planForm?.querySelectorAll("[data-next-step]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (planStep === 1 && !validatePlanStep(planSteps[0])) return;

      if (planStep === 2) {
        const formData = new FormData(planForm);
        if (!validatePlanStep(planSteps[1])) return;
        const screening = evaluateWellnessScreening(
          readWellnessScreening(formData)
        );
        const screeningProfile = {
          carePath:
            screening.status === "eligible" ? "wellness" : "needs_review",
          wellnessScreening: screening,
        };
        if (screening.status !== "eligible") {
          screeningProfile.wellnessPlan = null;
          screeningProfile.wellnessPlanAcceptedAt = null;
        }
        const cachedProfile = saveProfile(screeningProfile, {
          syncBackend: false,
          syncScreening: false,
        });
        renderWellnessOutcome(screening);
        button.disabled = true;
        if (wellnessScreeningStatus) {
          wellnessScreeningStatus.textContent = "Checking your answers securely…";
        }
        try {
          const result = await postWellnessScreening({
            not_treating_condition:
              screening.answers.notTreatingCondition === true,
            no_clinician_restrictions:
              screening.answers.noClinicianRestrictions === true,
            general_wellness_goal:
              screening.answers.generalWellnessGoal === true,
            no_concerning_symptoms:
              screening.answers.noConcerningSymptoms === true,
          });
          cachedProfile.wellnessScreening.screenedAt = result.screened_at;
          saveProfile(cachedProfile, {
            syncBackend: false,
            syncScreening: false,
          });
          if (wellnessScreeningStatus) {
            wellnessScreeningStatus.textContent = "";
          }
        } catch (error) {
          if (wellnessScreeningStatus) {
            wellnessScreeningStatus.textContent =
              error.message || "The safety screen could not be saved.";
          }
          return;
        } finally {
          button.disabled = false;
        }
        if (screening.status !== "eligible") {
          showPlanStep(4);
          return;
        }
      }
      showPlanStep(planStep + 1);
    });
  });

  planForm?.querySelectorAll("[data-prev-step]").forEach((button) => {
    button.addEventListener("click", () => showPlanStep(planStep - 1));
  });

  function readPlanPreferences() {
    const formData = new FormData(planForm);
    const goalLabel = String(formData.get("goal") || "Stay active");
    const numberOrNull = (name) => {
      const value = String(formData.get(name) ?? "").trim();
      return value ? Number(value) : null;
    };
    const hasRelevantHistory =
      formData.get("hasRelevantHistory") === "true";
    return {
      goal: GOAL_API_VALUES[goalLabel] ?? "stay_active",
      custom_goal:
        goalLabel === "Other"
          ? String(formData.get("customGoal") || "").trim()
          : "",
      activity_level:
        ACTIVITY_API_VALUES[String(formData.get("activity"))]
        ?? "lightly_active",
      focus_side: String(formData.get("focusSide") || "right"),
      cue_style: String(formData.get("cueStyle") || "gentle"),
      days_per_week: Number(formData.get("daysPerWeek") || 3),
      equipment: String(formData.get("equipment") || "chair"),
      planning_notes: String(
        formData.get("planningNotes") || ""
      ).trim(),
      has_relevant_history: hasRelevantHistory,
      medical_history: hasRelevantHistory
        ? String(formData.get("medicalHistory") || "").trim()
        : "",
      age: numberOrNull("age"),
      height_cm: numberOrNull("height"),
      weight_kg: numberOrNull("weight"),
    };
  }

  function setRequestBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.innerHTML;
      button.textContent = busyLabel;
    } else if (button.dataset.originalLabel) {
      button.innerHTML = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
    button.disabled = busy;
  }

  async function requestAiPlan(revision = "", triggerButton = null) {
    if (!validatePlanStep(planSteps[2])) return;
    const preferences = readPlanPreferences();
    const button =
      triggerButton ?? (revision ? requestPlanRevision : requestPlanDraft);
    const statusElement = revision
      ? plannerAcceptStatus
      : plannerRequestStatus;
    setRequestBusy(button, true, revision ? "Revising safely…" : "Creating a safe draft…");
    if (statusElement) {
      statusElement.textContent =
        "The AI is comparing your preferences with the reviewed exercise catalogue.";
    }
    try {
      const response = await generateWellnessPlan({
        ...preferences,
        previous_plan: activeWellnessPlan,
        revision,
      });
      activePlanPreferences = preferences;
      activePlanDraftToken = response.draft_token;
      renderWellnessPlan(response.plan, preferences.age);
      renderWellnessOutcome({ status: "eligible" });
      if (statusElement) statusElement.textContent = "";
      showPlanStep(4);
    } catch (error) {
      if (statusElement) {
        statusElement.textContent =
          error.message || "The AI could not create a draft.";
      }
    } finally {
      setRequestBusy(button, false);
    }
  }

  requestPlanDraft?.addEventListener("click", () => requestAiPlan());
  requestPlanRevision?.addEventListener("click", () => {
    const revision = planRevisionRequest?.value.trim();
    if (!revision) {
      planRevisionRequest?.focus();
      return;
    }
    requestAiPlan(revision, requestPlanRevision);
  });
  document.querySelectorAll("[data-revise-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      requestAiPlan(button.dataset.revisePlan, button);
    });
  });
  document.querySelector("[data-edit-plan-answers]")?.addEventListener(
    "click",
    () => showPlanStep(3)
  );

  function startAcceptedPlan() {
    const firstExerciseId = activeWellnessPlan?.days?.[0]?.exerciseIds?.[0];
    const exerciseSelect = document.getElementById("exerciseSelect");
    if (firstExerciseId && exerciseSelect) {
      exerciseSelect.value = firstExerciseId;
      exerciseSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    closeModal();
    if (window.pvStartPatientExercise) {
      window.pvStartPatientExercise(firstExerciseId);
    } else {
      document.getElementById("practice")?.scrollIntoView({ behavior: "smooth" });
    }
  }

  document.querySelector("[data-accept-plan]")?.addEventListener(
    "click",
    async (event) => {
      if (
        !activeWellnessPlan
        || !activePlanPreferences
        || !activePlanDraftToken
      ) return;
      const button = event.currentTarget;
      setRequestBusy(button, true, "Saving your accepted plan…");
      if (plannerAcceptStatus) {
        plannerAcceptStatus.textContent =
          "Rechecking the fixed safety rules before saving.";
      }
      try {
        const profile = await acceptWellnessPlan(activePlanDraftToken);
        const goalLabel = Object.entries(GOAL_API_VALUES).find(
          ([, value]) => value === profile.goal
        )?.[0] ?? "Stay active";
        saveProfile({
          name: planForm.elements.namedItem("name")?.value ?? "",
          age: activePlanPreferences.age,
          goal: goalLabel,
          customGoal: profile.custom_goal ?? "",
          activity: planForm.elements.namedItem("activity")?.value,
          focusSide: profile.focus_side,
          cueStyle: profile.cue_style,
          carePath: profile.care_path,
          pathwayChoice: profile.pathway_choice,
          wellnessPlan: profile.wellness_plan,
          wellnessPlanAcceptedAt: profile.wellness_plan_accepted_at,
          daysPerWeek: activePlanPreferences.days_per_week,
          equipment: activePlanPreferences.equipment,
          planningNotes: activePlanPreferences.planning_notes,
          hasRelevantHistory: Boolean(profile.medical_history),
          medicalHistory: profile.medical_history ?? "",
        }, {
          syncBackend: false,
          syncScreening: false,
        });
        activeWellnessPlan = profile.wellness_plan;
        if (plannerAcceptStatus) {
          plannerAcceptStatus.textContent = "Plan accepted.";
        }
        startAcceptedPlan();
      } catch (error) {
        if (plannerAcceptStatus) {
          plannerAcceptStatus.textContent =
            error.message || "The plan could not be saved.";
        }
      } finally {
        setRequestBusy(button, false);
      }
    }
  );

  document.querySelector("[data-review-screening]")?.addEventListener("click", () => {
    showPlanStep(2);
  });

  profileForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    syncEmergencyContactRequirements();
    if (!profileForm.reportValidity()) return;
    const formData = new FormData(profileForm);
    const profile = Object.fromEntries(formData.entries());
    profile.emergencyContactConsent =
      formData.get("emergencyContactConsent") === "true";
    const hasEmergencyContact = Boolean(
      String(profile.emergencyContactName ?? "").trim()
      || String(profile.emergencyContactRelationship ?? "").trim()
      || String(profile.emergencyContactPhone ?? "").trim()
    );
    if (!hasEmergencyContact) {
      profile.emergencyContactName = "";
      profile.emergencyContactRelationship = "";
      profile.emergencyContactPhone = "";
      profile.emergencyContactConsent = false;
    }
    if (profile.goal !== "Other") profile.customGoal = "";
    saveProfile(profile);
    closeModal(profileForm.closest(".modal-shell"));
  });

  emergencyContactSendCode?.addEventListener("click", async () => {
    syncEmergencyContactRequirements();
    if (!profileForm?.reportValidity()) return;
    if (!isLoggedIn()) {
      emergencyContactVerificationStatus.textContent =
        "Sign in before verifying an emergency contact.";
      return;
    }
    const contact = emergencyContactValuesFromForm();
    emergencyContactSendCode.disabled = true;
    emergencyContactVerificationStatus.textContent =
      "Saving the contact securely…";
    try {
      const apiProfile = await patchMe({
        emergency_contact_name: contact.emergencyContactName,
        emergency_contact_relationship:
          contact.emergencyContactRelationship,
        emergency_contact_phone: contact.emergencyContactPhone,
        emergency_contact_consent: contact.emergencyContactConsent,
      });
      saveProfile(profileContactFromApi(apiProfile), {
        syncBackend: false,
        syncScreening: false,
      });
      await startEmergencyContactVerification();
      emergencyContactCodeEntry.hidden = false;
      emergencyContactVerificationStatus.textContent =
        "Verification call requested. Ask your contact to share the 6-digit code spoken during the call.";
      emergencyContactCode.value = "";
      emergencyContactCode.focus();
    } catch (error) {
      emergencyContactVerificationStatus.textContent =
        error.message || "The verification call could not be requested.";
    } finally {
      renderEmergencyContactVerification(loadProfile());
    }
  });

  emergencyContactVerifyCode?.addEventListener("click", async () => {
    const code = emergencyContactCode?.value.trim() ?? "";
    if (!/^\d{6}$/.test(code)) {
      emergencyContactVerificationStatus.textContent =
        "Enter the 6-digit code received by your emergency contact.";
      emergencyContactCode?.focus();
      return;
    }
    emergencyContactVerifyCode.disabled = true;
    emergencyContactVerificationStatus.textContent = "Verifying contact…";
    try {
      const result = await confirmEmergencyContactVerification(code);
      const mapped = profileContactFromApi(result.profile);
      saveProfile(mapped, {
        syncBackend: false,
        syncScreening: false,
      });
      emergencyContactCodeEntry.hidden = true;
      emergencyContactVerificationStatus.textContent =
        mapped.emergencyContactAlertsReady
          ? "Contact verified. Automatic fall alerts are ready."
          : "Contact verified. The server notification provider still needs to be configured.";
      renderEmergencyContactVerification(loadProfile());
    } catch (error) {
      emergencyContactVerificationStatus.textContent =
        error.message || "The code could not be verified.";
    } finally {
      emergencyContactVerifyCode.disabled = false;
    }
  });

  function fillFormFromProfile(form, profile) {
    if (!form) return;
    for (const [key, value] of Object.entries(profile)) {
      const field = form.elements.namedItem(key);
      if (field && value !== undefined && value !== null) {
        if (field.type === "checkbox") {
          field.checked = value === true || value === "true";
        } else {
          field.value = String(value);
        }
      }
    }
  }

  function fillWellnessScreening(form, screening) {
    if (!form || !screening?.answers) return;
    WELLNESS_SCREENING_KEYS.forEach((key) => {
      if (typeof screening.answers[key] !== "boolean") return;
      const selector =
        `input[name="${key}"][value="${String(screening.answers[key])}"]`;
      const field = form.querySelector(selector);
      if (field) field.checked = true;
    });
  }

  document.querySelectorAll(".therapist-sidebar nav button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".therapist-sidebar nav button").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
    });
  });

  window.addEventListener("physiovision:language-change", () => {
    if (activeWellnessPlan?.days?.length) {
      renderWellnessPlan(activeWellnessPlan, activePlanPreferences?.age);
    }
  });
})();
