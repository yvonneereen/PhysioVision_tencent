import {
  getMe,
  isLoggedIn,
  sendAgentMessage,
} from "./api.js?v=32";
import { voiceGuidance } from "./voice-guidance.js?v=44";

const launcher = document.getElementById("agentChatLauncher");
const panel = document.getElementById("agentChatPanel");
const closeButton = document.getElementById("agentChatClose");
const title = document.getElementById("agentChatTitle");
const roleLabel = document.getElementById("agentChatRole");
const messages = document.getElementById("agentChatMessages");
const status = document.getElementById("agentChatStatus");
const form = document.getElementById("agentChatForm");
const input = document.getElementById("agentChatInput");
const submit = document.getElementById("agentChatSubmit");
const voiceButton = document.getElementById("agentChatVoice");

let activeRole = null;

function displayMessage(text, sender) {
  const message = document.createElement("p");
  message.className = `agent-chat-message agent-chat-message-${sender}`;
  message.textContent = text;
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(busy) {
  input.disabled = busy;
  submit.disabled = busy;
  voiceButton.disabled = busy || !voiceGuidance.canListen;
  submit.textContent = busy ? "Thinking…" : "Send";
  status.textContent = busy ? "Gemini is preparing a response." : "";
}

function setRole(role) {
  if (role === activeRole) return;
  activeRole = role;

  if (role === "clinician") {
    title.textContent = "Clinical assistant";
    roleLabel.textContent = "Physiotherapist configuration";
    displayMessage(
      "I can help summarise measured rehabilitation information. Clinical decisions remain yours.",
      "assistant",
    );
  } else {
    title.textContent = "Your movement companion";
    roleLabel.textContent = "Patient configuration";
    displayMessage(
      "Hello. I can explain your exercises in clear steps. I cannot diagnose conditions or replace your physiotherapist.",
      "assistant",
    );
  }
}

async function openChat() {
  if (!isLoggedIn()) {
    document.getElementById("headerSignIn")?.click();
    return;
  }

  panel.hidden = false;
  launcher.setAttribute("aria-expanded", "true");
  status.textContent = "Loading your assistant…";

  try {
    const user = await getMe();
    setRole(user.role);
    status.textContent = "";
    input.focus();
  } catch {
    status.textContent = "Please sign in again to use the assistant.";
  }
}

function closeChat() {
  panel.hidden = true;
  launcher.setAttribute("aria-expanded", "false");
  launcher.focus();
}

launcher?.addEventListener("click", () => {
  if (panel.hidden) {
    openChat();
  } else {
    closeChat();
  }
});

closeButton?.addEventListener("click", closeChat);

voiceButton.disabled = !voiceGuidance.canListen;
voiceButton?.addEventListener("click", () => {
  voiceGuidance.listen({
    onStatus: (message) => {
      status.textContent = message;
    },
    onError: (message) => {
      status.textContent = message;
    },
    onResult: (transcript) => {
      input.value = transcript;
      status.textContent = `I heard: “${transcript}”`;
      form.requestSubmit();
    },
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !panel.hidden) closeChat();
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  displayMessage(message, "user");
  input.value = "";
  setBusy(true);

  try {
    const result = await sendAgentMessage(message);
    setRole(result.role);
    displayMessage(result.reply, "assistant");
    if (result.role === "patient") {
      voiceGuidance.speak(result.reply, {
        key: `agent-reply:${result.reply}`,
      });
    }
  } catch (error) {
    displayMessage(
      error.message || "The assistant is unavailable. Exercise tracking will continue.",
      "error",
    );
  } finally {
    setBusy(false);
    input.focus();
  }
});
