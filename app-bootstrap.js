// Keep the public landing page light. Patient, clinician, camera, catalogue,
// and AI modules are loaded only when their interface is about to be used.
// This is especially important for Safari, where parsing the full application
// and compositing the animated landing page at the same time can monopolise a
// Web Content process on lower-power devices.

let movementPromise = null;
let sharedAccountPromise = null;
let patientPromise = null;
let clinicianPromise = null;

function loadMovementApp() {
  if (!movementPromise) {
    movementPromise = Promise.all([
      import("./exercise-library.js?v=21"),
      import("./main.js?v=163"),
    ]).catch((error) => {
      movementPromise = null;
      throw error;
    });
  }
  return movementPromise;
}

function loadSharedAccountApp() {
  if (!sharedAccountPromise) {
    sharedAccountPromise = Promise.all([
      import("./agent-chat.js?v=48"),
      import("./care-workflow.js?v=22"),
    ]).catch((error) => {
      sharedAccountPromise = null;
      throw error;
    });
  }
  return sharedAccountPromise;
}

function loadPatientApp() {
  if (!patientPromise) {
    patientPromise = Promise.all([
      loadSharedAccountApp(),
      import("./patient-dashboard.js?v=70"),
    ]).catch((error) => {
      patientPromise = null;
      throw error;
    });
  }
  return patientPromise;
}

function loadClinicianApp() {
  if (!clinicianPromise) {
    clinicianPromise = Promise.all([
      loadSharedAccountApp(),
      import("./therapist.js?v=50"),
    ]).catch((error) => {
      clinicianPromise = null;
      throw error;
    });
  }
  return clinicianPromise;
}

function loadAuthenticatedApp(role) {
  if (role === "patient") return loadPatientApp();
  if (role === "clinician") return loadClinicianApp();
  return Promise.resolve();
}

window.pvLoadAuthenticatedApp = loadAuthenticatedApp;
window.pvLoadMovementApp = loadMovementApp;

window.addEventListener("physiovision:auth-role", (event) => {
  const role = event.detail?.role;
  if (role) void loadAuthenticatedApp(role);
});

// Load the movement application shortly before its public preview scrolls into
// view, rather than while the hero and sign-in controls are becoming usable.
const movementSections = [
  document.getElementById("practice"),
  document.querySelector(".exercise-library-section"),
].filter(Boolean);

if ("IntersectionObserver" in window && movementSections.length) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    void loadMovementApp();
  }, { rootMargin: "600px 0px" });
  movementSections.forEach((section) => observer.observe(section));
}

// If a control is reached before its lazy module finishes loading, consume the
// first click, load the owning module, and replay that one click afterwards.
document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const chatLauncher = target.closest("#agentChatLauncher");
  if (chatLauncher && !sharedAccountPromise) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await loadSharedAccountApp();
      chatLauncher.click();
    } catch (error) {
      console.error("Account assistant could not be loaded", error);
    }
    return;
  }

  const movementControl = target.closest(
    "#practice button, #practice select, .exercise-library-section button"
  );
  if (movementControl && !movementPromise) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await loadMovementApp();
      movementControl.click();
    } catch (error) {
      console.error("Movement guide could not be loaded", error);
    }
  }
}, true);
