# Emergency-contact fall alerts

PhysioVision can request a Vonage voice call to a patient's verified emergency
contact after a possible fall. It never calls 995 or dispatches an ambulance.

## What the code now does

1. The browser detects a possible fall and immediately creates a durable alert
   on the Django API.
2. A one-minute countdown asks the patient to choose **I'm okay** or **I need
   help**. Hands-free voice remains available where the browser supports it.
3. **I'm okay** cancels a pending server alert.
4. **I need help** requests contact notification immediately.
5. No response lets the backend worker request contact notification when the
   countdown expires, even if the browser-side timer stops after the alert was
   registered.
6. Vonage is asked to place a voice call and speak the possible-fall alert. The
   UI reports requested, failed, or not-configured status without claiming that
   the contact answered.
7. A separate **Call 995 now** link opens the device dialler. The user or a
   nearby person must confirm and place that emergency call.

## Required production setup

### 1. Apply the database migrations

In the configured backend environment:

```bash
python3 manage.py migrate
```

This creates the contact-verification and durable emergency-alert records.

### 2. Create a Vonage Voice application

In the Vonage dashboard, create a Voice application and generate a public and
private key pair. Keep the application ID and downloaded private key. For a
demo account, open Vonage's **Try the Voice API** page and copy the exact
read-only **From** value displayed for the working test request. For the current
demo account that value is `12345678901`; do not shorten it to a generic test
value. The demo can call only the phone number registered to that account and
is limited by its trial credit and recipient restrictions.

Do **not** configure 995, 999, 112, or 911 as the saved contact. The code blocks
those short emergency-service numbers.

Add these secrets to the Django API service, not the frontend or Cloudflare
Pages:

```text
EMERGENCY_ALERT_PROVIDER=vonage
VONAGE_APPLICATION_ID=your-vonage-application-id
VONAGE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
VONAGE_FROM_NUMBER=12345678901
VONAGE_DEMO_MODE=True
VONAGE_DEMO_TO_NUMBER=+6580380208
EMERGENCY_ALERT_DELAY_SECONDS=60
EMERGENCY_CONTACT_VERIFICATION_TTL_MINUTES=10
EMERGENCY_CONTACT_VERIFICATION_COOLDOWN_SECONDS=60
EMERGENCY_CONTACT_VERIFICATION_MAX_ATTEMPTS=5
```

Replace the example recipient with the phone number verified in your Vonage
account. `VONAGE_DEMO_TO_NUMBER` is an allowlist: contact verification and fall
calls will be rejected if the saved contact has a different number.

With `VONAGE_DEMO_MODE=True`, the backend uses the normalized value of
`VONAGE_FROM_NUMBER` and restricts calls to `VONAGE_DEMO_TO_NUMBER`. Copy the
caller ID exactly from the successful request shown in Vonage's dashboard.
A paid deployment using a rented Vonage number must set
`VONAGE_DEMO_MODE=False` and set `VONAGE_FROM_NUMBER` to that rented number.

In Render, add the complete contents of the downloaded `.key` file as the
`VONAGE_PRIVATE_KEY` secret. It may be a multiline value. Never expose the
private key in `runtime-config.js`, browser JavaScript, GitHub, or a Pages
environment variable that is bundled into frontend assets.

The implementation sends an inline NCCO (the spoken call instructions) directly
to Vonage. It does not require a TwiML Bin, webhook, public answer URL, or Vonage
Functions service.

### 3. Run the durable alert worker

Create a continuously running background-worker service using the same code,
database, and environment variables as the Django API. Its start command is:

```bash
python3 manage.py process_emergency_alerts --watch --interval 2
```

For Render, create **New → Background Worker**, connect the same repository and
branch as the API, use `pip install -r requirements.txt` as the build command,
and use the command above as the start command. Copy the API service's
`DATABASE_URL`, `SECRET_KEY`, Vonage settings, and other required environment
variables into the worker. The worker and API must point at the same database.

The frontend also submits the response at the end of its countdown, but the
worker is required for the unconscious-user case because browser timers can
stop when a tab, browser, device, or network session stops.

For a short free-trial recording, you can test **I need help** while the page is
open without creating a paid worker: the Django API requests the call
immediately. Do not claim that no-response alerts are durable until the worker
is running continuously.

Do not run multiple development auto-reload workers. In production, use one
managed worker initially and monitor its health before scaling it.

### 4. Verify a contact before enabling alerts

1. Sign in as the patient.
2. Open **My profile**.
3. Enter the contact's name, relationship, and complete international phone
   number.
4. Confirm that the person agreed to receive automated fall alerts.
5. Select **Send verification code**. Vonage calls the contact and speaks the
   code twice.
6. Ask the contact to share the spoken six-digit code.
7. Enter it and confirm that the profile says **Verified and ready for
   automatic alerts**.

Changing or removing the phone number invalidates verification.

### 5. Test without calling emergency services

Use phone numbers belonging to the development team and contact owners who
have agreed to the test. Never use 995 for a test.

Test all of these cases:

- **I'm okay** before expiry: no call is requested.
- **I need help**: a voice call is requested immediately.
- No response: the worker requests the call after the countdown.
- Invalid or missing provider credentials: the UI says no automatic alert was
  sent and continues showing the manual 995 action.
- Safari loses camera, microphone, network, or page visibility: the product
  continues to describe the feature as an additional safeguard, not guaranteed
  monitoring.

## Important limitations before real patient use

- A provider request ID means Vonage accepted the call request. It does not prove
  that the phone rang or that the contact answered. Add authenticated Vonage
  event webhooks and delivery-state handling before claiming delivery.
- The alert currently contains no live location. If location is added, obtain
  explicit consent, record timestamp and accuracy, and clearly identify stale
  or unavailable positions. SCDF needs an accurate location from the person who
  calls 995.
- Emergency-contact details are sensitive personal data. Before production,
  complete a privacy/legal review, establish retention and deletion rules,
  restrict staff access, and use appropriate database encryption and audit
  logging.
- Add provider failover, worker-health monitoring, alert-age monitoring, and an
  operator escalation path before presenting the feature as dependable
  unattended monitoring.
- A normal website cannot guarantee fall detection when the tab is closed, the
  device is locked or unpowered, the internet is unavailable, camera permission
  ends, or the person falls outside the frame. A regulated telecare service or
  native phone/watch integration is required for stronger unattended coverage.
