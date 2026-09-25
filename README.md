# Ari Meet

Ari Meet is a full-stack video meeting application built with Next.js. It provides authenticated meeting creation, browser-based audio/video calls, realtime chat, host controls, breakout rooms, recordings, live captions, transcription, topic descriptions, and transcript scoring.

## Highlights

- Clerk authentication for the protected application area
- Instant and scheduled meetings with host and participant links
- Camera and microphone choices on the pre-join screen
- WebRTC media and Socket.IO signaling
- Realtime chat, reactions, screen sharing, hand raising, and participant controls
- Host admission lobby, host transfer, mute controls, and meeting closure
- Breakout room creation, assignment, joining, and closure
- Audio and meeting recording persistence
- Live caption events stored in MariaDB
- Whisper transcription through a FastAPI service
- Optional local T5 topic descriptions and transcript scoring, with a text fallback when the model is unavailable
- Docker Compose setup for Next.js, FastAPI, and MariaDB

## Architecture

```text
Browser
  |
  v
Next.js web service :3000
  |-- Clerk authentication
  |-- App Router pages and API routes
  |-- Socket.IO signaling via /api/socket
  |-- Prisma MariaDB access
  |-- HTTP requests to the Python service
  |
  +--> FastAPI ML service :5001
  |      |-- Whisper transcription
  |      +-- Optional T5 topic generation and scoring
  |
  +--> MariaDB :3306
         |-- Meetings and participants
         |-- Sessions and breakout rooms
         |-- Recordings and transcripts
         +-- Live captions
```

The Socket.IO state is held in the Node process. A multi-replica deployment therefore needs sticky sessions and a shared Socket.IO adapter such as Redis.

## Requirements

For native development:

- Node.js 20 or newer
- npm
- Python 3.11 recommended
- FFmpeg for Whisper audio processing
- MariaDB or MySQL
- Clerk application credentials
- Stream credentials if Stream features are enabled

For Docker:

- Docker Desktop with the Linux engine enabled
- Docker Compose v2

## Configuration

Never commit `.env`, `.env.local`, or `.env.docker`. Use the example file as a template:

```powershell
Copy-Item .env.docker.example .env.docker
```

Important variables:

| Variable | Used by | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Web | Clerk publishable key |
| `CLERK_SECRET_KEY` | Web | Clerk server secret |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Web | Sign-in route, normally `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Web | Sign-up route, normally `/sign-up` |
| `NEXT_PUBLIC_STREAM_API_KEY` | Web | Stream public API key |
| `STREAM_SECRET_KEY` | Web | Stream server secret |
| `DATABASE_URL` | Web/Prisma | MySQL or MariaDB connection string |
| `PYTHON_SERVICE_URL` | Web | FastAPI URL; Docker uses `http://python:5001` |
| `NEXT_PUBLIC_BASE_URL` | Web | Base URL used for meeting links |
| `APP_URL` | Web | Public URL used for invitation emails |
| `NEXT_PUBLIC_SOCKET_SERVER_URL` | Browser | Optional public Socket.IO origin |
| `EMAIL_USER` | Web | SMTP/Gmail sender account |
| `EMAIL_PASS` | Web | SMTP/Gmail app password |
| `WHISPER_MODEL` | Python | Whisper model name; defaults to `base` |
| `MARIADB_DATABASE` | Docker | Database name |
| `MARIADB_USER` | Docker | Database user |
| `MARIADB_PASSWORD` | Docker | Database password |
| `MARIADB_ROOT_PASSWORD` | Docker | MariaDB root password |
| `WEB_PORT` | Docker | Host port mapped to web port 3000 |

The checked-in example contains placeholders only. The local `.env.local` file may contain development values and must remain private.

## Native Development

1. Install JavaScript dependencies:

```powershell
npm ci
```

1. Install Python dependencies in a virtual environment:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

1. Install FFmpeg and make sure `ffmpeg` is available on `PATH`.

1. Set `DATABASE_URL` and the application credentials in `.env.local`.

1. Generate the Prisma client and apply migrations:

```powershell
npx prisma generate
npx prisma migrate dev
```

1. Start MariaDB and the Python service. In one terminal:

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn server:app --host 0.0.0.0 --port 5001
```

1. Start the Next.js application in another terminal:

```powershell
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Docker Compose

Docker Compose runs three services:

- `web`: Next.js, API routes, and Socket.IO on port `3000`
- `python`: FastAPI ML service on the private Compose network at port `5001`
- `db`: MariaDB on the private Compose network

Create a private Docker environment file and fill in the required Clerk and Stream values:

```powershell
Copy-Item .env.docker.example .env.docker
notepad .env.docker
```

Start the stack:

```powershell
docker compose --env-file .env.docker up --build
```

Open [http://localhost:3000](http://localhost:3000). The web container runs `prisma migrate deploy` before starting Next.js.

Useful commands:

```powershell
# Run in the background
docker compose --env-file .env.docker up --build -d

# Show service status
docker compose --env-file .env.docker ps

# Follow logs
docker compose --env-file .env.docker logs -f web

# Stop services but keep named volumes
docker compose --env-file .env.docker down

# Stop services and delete database/recording volumes
docker compose --env-file .env.docker down -v
```

The Compose file persists MariaDB data in `mariadb_data` and recordings in `recordings_data`. The local T5 model is intentionally excluded from the Python Docker build context. If it is not available to the Python service, topic generation and scoring use the built-in fallback paragraph.

## Application Flow

### Create a meeting

From the dashboard, choose **New Meeting** for an instant host meeting or **Schedule Meeting** for a future meeting. The application creates a `room-*` identifier, stores meeting metadata through `/api/meetings`, and generates host and participant links.

### Join a meeting

A host opens the host link with `host=true`. A participant opens the participant link. The meeting page displays a pre-join screen where camera and microphone defaults can be selected before browser media permissions are requested.

### During a meeting

The meeting client connects to the Socket.IO endpoint and exchanges WebRTC offers, answers, and ICE candidates. Participants can use chat, reactions, screen sharing, live captions, recording, and participant controls. Hosts can admit lobby users, manage microphones, create breakout rooms, transfer host privileges, and close the meeting.

## API Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/meetings` | `GET` | List meetings for the authenticated user |
| `/api/meetings` | `POST` | Create and persist a meeting |
| `/api/recordings` | `GET` | List recordings and associated metadata |
| `/api/transcriptions` | `GET` | List stored recording transcripts |
| `/api/score-text` | `POST` | Score text against a topic through FastAPI |
| `/api/send-invite` | `POST` | Send participant invitations through configured email |
| `/api/socket` | `GET`/`POST` | Initialize Socket.IO and return meeting summaries |
| `/transcribe` | `POST` | FastAPI endpoint for audio transcription |
| `/topic-description` | `POST` | FastAPI endpoint for topic description generation |
| `/score` | `POST` | FastAPI endpoint for transcript/topic scoring |

The FastAPI endpoints are private in Docker and should not be exposed publicly without authentication and rate limiting.

## Database

Prisma uses the MySQL provider with the MariaDB adapter. Schema changes live in `prisma/migrations`.

Native development:

```powershell
npx prisma migrate dev
```

Production/container startup:

```powershell
npx prisma migrate deploy
```

The Docker web entrypoint runs `prisma migrate deploy` automatically before starting the standalone Next.js server.

## Project Layout

```text
app/                  Next.js App Router pages and API routes
components/           Dashboard, meeting, and UI components
pages/api/socket.js   Socket.IO signaling and meeting state
public/js/            Browser meeting client scripts
public/css/           Meeting and breakout-room styles
server.py             FastAPI Whisper/T5 service
prisma/               Prisma schema and migrations
lib/prisma.ts         MariaDB-backed Prisma client
Dockerfile             Standalone Next.js image
Dockerfile.python      FastAPI/ML image
docker-compose.yml     Web, Python, and MariaDB services
```

## Validation

Run the JavaScript production build:

```powershell
npm run build
```

Check the browser meeting script:

```powershell
node --check public/js/meeting.js
```

Check Python syntax:

```powershell
python -m py_compile server.py
```

Validate Compose interpolation without starting services:

```powershell
docker compose --env-file .env.docker config --quiet
```

## Storage and Scaling Notes

- Recordings currently use `public/recordings`; use object storage for production and backups.
- Socket.IO meeting state is process-local; use sticky sessions and a shared adapter before scaling horizontally.
- WebRTC connectivity depends on browser permissions and reachable STUN/TURN servers.
- Whisper model downloads can be large and require network access when the Python service starts for the first time.
- The local T5 model is optional. Keeping it outside Git and Docker contexts keeps repository and image builds manageable.

## Security Notes

- Rotate any credential that has been exposed in a terminal, screenshot, commit, or chat.
- Use a Gmail app password or another SMTP credential for invitations; do not use a primary account password.
- Do not commit environment files, model weights, recordings, database dumps, or generated build folders.
- Use HTTPS for public deployments and set the public URL variables consistently.
- Add authentication, authorization, rate limiting, and file validation before exposing the ML endpoints directly.

## License

No license file is currently included in this repository. Add a license before publishing the project for reuse.
