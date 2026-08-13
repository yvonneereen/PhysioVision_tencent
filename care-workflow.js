import {
  acceptCareInvitation,
  createCareInvitation,
  createPrescription,
  getClinicianPatients,
  getExercises,
  getMe,
  getPrescriptions,
  isLoggedIn,
} from "./api.js?v=35";
import { saveProfile } from "./personalization.js?v=13";

const patientCareLink = document.getElementById("patientCareLink");
const careInviteCode = document.getElementById("careInviteCode");
const acceptCareInviteButton = document.getElementById("acceptCareInvite");
const careInviteStatus = document.getElementById("careInviteStatus");
const profileCarePathStatus = document.getElementById("profileCarePathStatus");

const clinicianAccessMessage = document.getElementById("clinicianAccessMessage");
const clinicianWorkspace = document.getElementById("clinicianWorkspace");
const createCareInviteButton = document.getElementById("createCareInvite");
const careInviteResult = document.getElementById("careInviteResult");
const careInviteResultCode = document.getElementById("careInviteResultCode");
const careInviteExpiry = document.getElementById("careInviteExpiry");
const clinicianInviteStatus = document.getElementById("clinicianInviteStatus");
const prescriptionForm = document.getElementById("prescriptionForm");
const patientSelect = document.getElementById("prescriptionPatient");
const exerciseSelect = document.getElementById("prescriptionExercise");
const prescriptionStatus = document.getElementById("prescriptionStatus");
const patientRows = document.getElementById("clinicianPatientRows");
const linkedPatientCount = document.getElementById("linkedPatientCount");
const activePrescriptionCount = document.getElementById("activePrescriptionCount");

let currentRole = null;

function results(data) {
  return data?.results ?? data ?? [];
}

function isCurrentPrescription(prescription) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    prescription.is_active &&
    prescription.valid_from <= today &&
    (!prescription.valid_until || prescription.valid_until >= today)
  );
}

function setRoleInterface(role) {
  currentRole = role;
  patientCareLink?.classList.toggle("hidden", role !== "patient");
  clinicianWorkspace?.classList.toggle("hidden", role !== "clinician");
  clinicianAccessMessage?.classList.toggle("hidden", role === "clinician");
}

function renderPatientPath(profile) {
  if (!profileCarePathStatus || !profile) return;
  const labels = {
    wellness: "General wellness · screening confirmed",
    clinician: "Clinician-guided rehabilitation · active prescription",
    needs_review: profile.primary_clinician
      ? "Linked to clinician · awaiting active prescription"
      : "Professional review needed",
  };
  profileCarePathStatus.textContent =
    labels[profile.care_path] ?? "Pathway not assigned";
}

async function detectRole() {
  if (!isLoggedIn()) {
    setRoleInterface(null);
    return null;
  }
  try {
    const user = await getMe();
    setRoleInterface(user.role);
    if (user.role === "patient") renderPatientPath(user.profile);
    return user.role;
  } catch (_) {
    setRoleInterface(null);
    return null;
  }
}

function addOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function renderPatients(patients) {
  patientSelect.innerHTML = "";
  patientRows.innerHTML = "";
  linkedPatientCount.textContent = String(patients.length);

  if (!patients.length) {
    addOption(patientSelect, "", "No linked patients yet");
    patientSelect.disabled = true;
    const empty = document.createElement("p");
    empty.className = "clinician-empty-state";
    empty.textContent =
      "Generate an invitation code and ask the patient to accept it first.";
    patientRows.appendChild(empty);
    return;
  }

  patientSelect.disabled = false;
  patients.forEach((patient) => {
    addOption(patientSelect, patient.id, patient.name);

    const row = document.createElement("div");
    row.className = "patient-row clinician-patient-row";
    const name = document.createElement("span");
    name.className = "patient-name";
    const nameText = document.createElement("strong");
    nameText.textContent = patient.name;
    name.appendChild(nameText);
    const email = document.createElement("span");
    email.textContent = patient.email;
    const count = document.createElement("span");
    count.textContent = String(patient.active_prescriptions);
    const pathway = document.createElement("span");
    pathway.textContent = patient.active_prescriptions
      ? "Clinician guided"
      : "Awaiting programme";
    row.append(name, email, count, pathway);
    patientRows.appendChild(row);
  });
}

function renderExercises(exercises) {
  exerciseSelect.innerHTML = "";
  exercises
    .filter((exercise) => exercise.is_active)
    .forEach((exercise) => {
      addOption(exerciseSelect, exercise.id, exercise.name);
    });
  exerciseSelect.disabled = exerciseSelect.options.length === 0;
}

async function loadClinicianWorkspace() {
  if (currentRole !== "clinician") return;
  if (
    !clinicianWorkspace ||
    !prescriptionStatus ||
    !patientSelect ||
    !exerciseSelect ||
    !patientRows
  ) {
    // The clinician overview can be supplied by therapist.js without the
    // optional invitation-and-prescription workspace being present.
    return;
  }
  prescriptionStatus.textContent = "Loading linked patients and exercises…";
  try {
    const [patients, exercises, prescriptions] = await Promise.all([
      getClinicianPatients(),
      getExercises(),
      getPrescriptions(),
    ]);
    renderPatients(results(patients));
    renderExercises(results(exercises));
    activePrescriptionCount.textContent = String(
      results(prescriptions).filter(isCurrentPrescription).length
    );
    prescriptionStatus.textContent = "";
  } catch (error) {
    prescriptionStatus.textContent =
      error.message || "The clinician workspace could not be loaded.";
  }
}

acceptCareInviteButton?.addEventListener("click", async () => {
  const code = careInviteCode.value.trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(code)) {
    careInviteStatus.textContent = "Enter the complete 8-character code.";
    return;
  }

  acceptCareInviteButton.disabled = true;
  careInviteStatus.textContent = "Checking invitation…";
  try {
    const result = await acceptCareInvitation(code);
    saveProfile({
      carePath: result.care_path,
    });
    careInviteStatus.textContent =
      `Connected to ${result.clinician}. Your programme is awaiting assignment.`;
    profileCarePathStatus.textContent =
      "Linked to clinician · awaiting active prescription";
    careInviteCode.value = "";
  } catch (error) {
    careInviteStatus.textContent =
      error.message || "The invitation could not be accepted.";
  } finally {
    acceptCareInviteButton.disabled = false;
  }
});

createCareInviteButton?.addEventListener("click", async () => {
  createCareInviteButton.disabled = true;
  clinicianInviteStatus.textContent = "Creating a one-time code…";
  try {
    const invitation = await createCareInvitation();
    careInviteResultCode.textContent = invitation.code;
    careInviteExpiry.textContent =
      `Expires ${new Date(invitation.expires_at).toLocaleString()}`;
    careInviteResult.classList.remove("hidden");
    clinicianInviteStatus.textContent =
      "The raw code is shown only now. Share it with the intended patient.";
  } catch (error) {
    clinicianInviteStatus.textContent =
      error.message || "The invitation could not be created.";
  } finally {
    createCareInviteButton.disabled = false;
  }
});

prescriptionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!prescriptionForm.reportValidity()) return;
  const data = new FormData(prescriptionForm);
  const validUntil = String(data.get("valid_until") ?? "").trim();

  const payload = {
    patient: data.get("patient"),
    exercise: data.get("exercise"),
    sets: Number(data.get("sets")),
    reps: Number(data.get("reps")),
    hold_seconds: Number(data.get("hold_seconds") || 0),
    days_per_week: String(data.get("days_per_week")).trim(),
    notes: String(data.get("notes") ?? "").trim(),
    is_active: true,
    valid_from: data.get("valid_from"),
  };
  if (validUntil) payload.valid_until = validUntil;

  const submit = prescriptionForm.querySelector("[type='submit']");
  submit.disabled = true;
  prescriptionStatus.textContent = "Saving the prescription…";
  try {
    const prescription = await createPrescription(payload);
    prescriptionStatus.textContent =
      `${prescription.exercise_name} was assigned to ${prescription.patient_name}.`;
    await loadClinicianWorkspace();
  } catch (error) {
    const details = error.data
      ? Object.values(error.data).flat().join(" ")
      : error.message;
    prescriptionStatus.textContent =
      details || "The prescription could not be saved.";
  } finally {
    submit.disabled = false;
  }
});

document.querySelectorAll("[data-open='therapist-view']").forEach((button) => {
  button.addEventListener("click", async () => {
    const role = currentRole ?? await detectRole();
    if (role === "clinician") {
      await loadClinicianWorkspace();
    }
  });
});

window.addEventListener("physiovision:auth-role", async (event) => {
  setRoleInterface(event.detail?.role ?? null);
  if (currentRole === "patient") {
    renderPatientPath(event.detail?.user?.profile);
  }
  if (currentRole === "clinician") await loadClinicianWorkspace();
});

const startDate = prescriptionForm?.elements.namedItem("valid_from");
if (startDate) startDate.value = new Date().toISOString().slice(0, 10);
detectRole();
