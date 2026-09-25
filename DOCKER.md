# Docker deployment

Ari Meet runs as three Compose services:

- `web`: Next.js, API routes, and Socket.IO on port `3000`
- `python`: FastAPI transcription/scoring service on port `5001` (private Compose network)
- `db`: MariaDB on the private Compose network

## Local startup

1. Copy `.env.docker.example` to `.env.docker` and set the Clerk and Stream values.
2. Change the database passwords in `.env.docker`.
3. Start the stack:

```powershell
docker compose --env-file .env.docker up --build
```

Open `http://localhost:3000` after the `web` service starts. The web container runs `prisma migrate deploy` before starting Next.js.

## Persistent data

Compose stores MariaDB data in `mariadb_data` and uploaded recordings in `recordings_data`. Back up these volumes before removing the stack. For production, object storage is preferable for recordings and a managed MariaDB/MySQL service is preferable for the database.

## Production notes

- Do not commit `.env.docker` or any secret values.
- Set `NEXT_PUBLIC_BASE_URL`, `APP_URL`, and `NEXT_PUBLIC_SOCKET_SERVER_URL` to the public HTTPS origin when deploying behind a reverse proxy.
- Socket.IO state is process-local; use sticky sessions and a Socket.IO adapter before running multiple web replicas.
- The Python image downloads the configured Whisper model (`WHISPER_MODEL`, default `base`) when the service starts.
- The local `t5-base-model` directory is optional and intentionally excluded from the Docker build context. Without it, scoring uses the built-in topic fallback text.
