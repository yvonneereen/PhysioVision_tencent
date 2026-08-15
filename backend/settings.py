"""
Django settings for backend project.

Generated with `django-admin startproject`; maintained against Django 5.2 LTS.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/topics/settings/

For the full list of settings and their values, see
https://docs.djangoproject.com/en/5.2/ref/settings/
"""

from pathlib import Path
import environ

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DEBUG=(bool, True),
    ALLOWED_HOSTS=(list, ['localhost', '127.0.0.1']),
)
environ.Env.read_env(BASE_DIR / '.env')

SECRET_KEY = env('SECRET_KEY')
DEBUG = env('DEBUG')
ALLOWED_HOSTS = env('ALLOWED_HOSTS')

# Render exposes the deployed service hostname automatically. Keeping this
# separate from CORS is important: ALLOWED_HOSTS identifies the API server,
# while CORS_ALLOWED_ORIGINS identifies browser frontends allowed to call it.
RENDER_EXTERNAL_HOSTNAME = env('RENDER_EXTERNAL_HOSTNAME', default='')
if RENDER_EXTERNAL_HOSTNAME and RENDER_EXTERNAL_HOSTNAME not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(RENDER_EXTERNAL_HOSTNAME)

GEMINI_API_KEY = env('GEMINI_API_KEY', default='')
GEMINI_MODEL = env('GEMINI_MODEL', default='gemini-3.6-flash')
GEMINI_PLANNER_TIMEOUT_MS = env.int(
    'GEMINI_PLANNER_TIMEOUT_MS',
    default=50000,
)
GEMINI_TTS_MODEL = env(
    'GEMINI_TTS_MODEL',
    default='gemini-3.1-flash-tts-preview',
)
GEMINI_TTS_VOICE = env('GEMINI_TTS_VOICE', default='Sulafat')


# Application definition

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'api.core',
    'api.catalogue',
    'api.sessions',
    'api.consultations',
    'api.slack_bot',
    'rest_framework',
    'rest_framework.authtoken',
    'corsheaders',
]

AUTH_USER_MODEL = 'core.User'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'api.core.authentication.ExpiringTokenAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_THROTTLE_RATES': {
        'auth_register': '5/hour',
        'auth_login': '10/minute',
        'login_verification': '10/hour',
        'login_verification_resend': '5/hour',
        'email_verification': '10/hour',
        'email_verification_resend': '5/hour',
        'password_reset_request': '5/hour',
        'password_reset_verify': '10/hour',
        'password_reset_confirm': '5/hour',
        'wellness_plan_draft': '12/hour',
        'emergency_contact_verification': '5/hour',
        'emergency_alert_create': '12/hour',
        'emergency_alert_response': '30/hour',
        'emergency_alert_status': '180/hour',
        'safety_language_interpretation': '60/hour',
        'guidance_speech': '180/hour',
        'agent_chat': '60/hour',
        'consultation_draft': '20/hour',
    },
}

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'backend.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'backend.wsgi.application'


# Database
# https://docs.djangoproject.com/en/5.2/ref/settings/#databases

DATABASES = {
    'default': env.db(default=f'sqlite:///{BASE_DIR / "db.sqlite3"}')
}
DATABASES['default']['CONN_MAX_AGE'] = env.int('DB_CONN_MAX_AGE', default=60)
DATABASES['default']['CONN_HEALTH_CHECKS'] = True


# Password validation
# https://docs.djangoproject.com/en/5.2/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]


# Internationalization
# https://docs.djangoproject.com/en/5.2/topics/i18n/

LANGUAGE_CODE = 'en-us'

TIME_ZONE = 'UTC'

USE_I18N = True

USE_TZ = True


# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/5.2/howto/static-files/

STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    'default': {
        'BACKEND': 'django.core.files.storage.FileSystemStorage',
    },
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
    },
}

# Local development defaults to accepting browser origins. A production
# deployment with DEBUG=False defaults to the explicit origin allow-list.
CORS_ALLOW_ALL_ORIGINS = env.bool(
    'CORS_ALLOW_ALL_ORIGINS',
    default=DEBUG,
)
CORS_ALLOWED_ORIGINS = env.list(
    'CORS_ALLOWED_ORIGINS',
    default=[],
)
CSRF_TRUSTED_ORIGINS = env.list(
    'CSRF_TRUSTED_ORIGINS',
    default=[],
)

# Render terminates HTTPS at its proxy and forwards the original scheme.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG

# Email delivery, verification, password recovery, and API session security.
# EMAIL_PROVIDER=gmail_api sends through Gmail with an OAuth refresh token.
# Django email remains available for local development and automated tests.
EMAIL_PROVIDER = env('EMAIL_PROVIDER', default='django').strip().lower()
EMAIL_BACKEND = env(
    'EMAIL_BACKEND',
    default=(
        'django.core.mail.backends.console.EmailBackend'
        if DEBUG
        else 'django.core.mail.backends.smtp.EmailBackend'
    ),
)
EMAIL_HOST = env('EMAIL_HOST', default='')
EMAIL_PORT = env.int('EMAIL_PORT', default=587)
EMAIL_HOST_USER = env('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = env('EMAIL_HOST_PASSWORD', default='')
EMAIL_USE_TLS = env.bool('EMAIL_USE_TLS', default=True)
DEFAULT_FROM_EMAIL = env(
    'DEFAULT_FROM_EMAIL',
    default='PhysioVision <no-reply@physiovision.app>',
)
GMAIL_CLIENT_ID = env('GMAIL_CLIENT_ID', default='')
GMAIL_CLIENT_SECRET = env('GMAIL_CLIENT_SECRET', default='')
GMAIL_REFRESH_TOKEN = env('GMAIL_REFRESH_TOKEN', default='')
GMAIL_SENDER_EMAIL = env('GMAIL_SENDER_EMAIL', default='')
GMAIL_SENDER_NAME = env('GMAIL_SENDER_NAME', default='PhysioVision')
EMAIL_VERIFICATION_CODE_TTL_MINUTES = env.int(
    'EMAIL_VERIFICATION_CODE_TTL_MINUTES',
    default=10,
)
EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = env.int(
    'EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS',
    default=60,
)
EMAIL_VERIFICATION_MAX_ATTEMPTS = env.int(
    'EMAIL_VERIFICATION_MAX_ATTEMPTS',
    default=5,
)
PASSWORD_RESET_CODE_TTL_MINUTES = env.int(
    'PASSWORD_RESET_CODE_TTL_MINUTES',
    default=10,
)
PASSWORD_RESET_TOKEN_TTL_MINUTES = env.int(
    'PASSWORD_RESET_TOKEN_TTL_MINUTES',
    default=15,
)
PASSWORD_RESET_RESEND_COOLDOWN_SECONDS = env.int(
    'PASSWORD_RESET_RESEND_COOLDOWN_SECONDS',
    default=60,
)
PASSWORD_RESET_MAX_ATTEMPTS = env.int(
    'PASSWORD_RESET_MAX_ATTEMPTS',
    default=5,
)
AUTH_TOKEN_TTL_HOURS = env.int('AUTH_TOKEN_TTL_HOURS', default=12)

# Automatic fall notifications contact only the patient's verified emergency
# contact. They never dial emergency-service numbers. Keep disabled until a
# compliant Singapore-capable outbound caller and worker are configured.
EMERGENCY_ALERT_PROVIDER = env(
    'EMERGENCY_ALERT_PROVIDER',
    default='disabled',
).strip().lower()
VONAGE_APPLICATION_ID = env('VONAGE_APPLICATION_ID', default='')
VONAGE_PRIVATE_KEY = env('VONAGE_PRIVATE_KEY', default='')
VONAGE_FROM_NUMBER = env('VONAGE_FROM_NUMBER', default='')
# Demo mode restricts delivery to the configured trial recipient. The caller
# ID still comes from VONAGE_FROM_NUMBER because Vonage's dashboard can assign
# an account-specific test value.
VONAGE_DEMO_MODE = env.bool('VONAGE_DEMO_MODE', default=True)
# Free Vonage demo accounts may call only a verified number. This allowlist is
# also a safety control: emergency alerts cannot be redirected to another phone.
VONAGE_DEMO_TO_NUMBER = env('VONAGE_DEMO_TO_NUMBER', default='')
EMERGENCY_ALERT_DELAY_SECONDS = env.int(
    'EMERGENCY_ALERT_DELAY_SECONDS',
    default=60,
)
EMERGENCY_CONTACT_VERIFICATION_TTL_MINUTES = env.int(
    'EMERGENCY_CONTACT_VERIFICATION_TTL_MINUTES',
    default=10,
)
EMERGENCY_CONTACT_VERIFICATION_COOLDOWN_SECONDS = env.int(
    'EMERGENCY_CONTACT_VERIFICATION_COOLDOWN_SECONDS',
    default=60,
)
EMERGENCY_CONTACT_VERIFICATION_MAX_ATTEMPTS = env.int(
    'EMERGENCY_CONTACT_VERIFICATION_MAX_ATTEMPTS',
    default=5,
)

# Slack Physio Assistant AI
SLACK_BOT_TOKEN     = env('SLACK_BOT_TOKEN', default='')
SLACK_SIGNING_SECRET = env('SLACK_SIGNING_SECRET', default='')
# Shared channel for escalations about patients with no linked clinician.
# The bot must be a member. Leave blank to skip such alerts entirely.
SLACK_TRIAGE_CHANNEL_ID = env('SLACK_TRIAGE_CHANNEL_ID', default='')
# Shareable workspace invite link (created manually in Slack) shown to
# clinicians so they can join the workspace before linking their account.
SLACK_WORKSPACE_INVITE_URL = env('SLACK_WORKSPACE_INVITE_URL', default='')

# Frontend base URL (used in Slack deep links)
FRONTEND_URL = env('FRONTEND_URL', default='http://localhost:4173')
