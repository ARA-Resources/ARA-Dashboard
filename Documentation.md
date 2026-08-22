# ARA Dashboard - Codebase & Deployment Documentation

This document provides an in-depth explanation of the ARA Dashboard codebase, its architecture, and detailed instructions on how to deploy it using Docker on a VPS.

---

## 1. Project Overview

**ARA Dashboard** is a comprehensive recruitment resource management system designed to track, manage, and analyze candidate pipelines across different business units (`Lateral`, `Executive`, `Consulting`).

The application is built as a monolithic full-stack application using **Next.js (App Router)**. It serves both the frontend UI and backend API routes from the same server, connecting to a **PostgreSQL** database for persistent storage. It also integrates with external data sources like local Excel files and Google Drive.

### Core Technologies
- **Framework**: Next.js 16 (App Router) with TypeScript.
- **Styling**: Tailwind CSS v4, integrated with `shadcn/ui` for accessible and reusable UI components.
- **State Management & Data Fetching**: `Zustand` for global client state, and `@tanstack/react-query` for asynchronous data fetching and caching.
- **Data Visualization & Tables**: `Recharts` for charts/graphs, `@tanstack/react-table` for complex data grids.
- **Database**: PostgreSQL (interacted with via the `postgres` Node.js driver), with a custom migration runner.
- **Data Processing**: `exceljs` for reading/writing Excel workbooks.

---

## 2. Codebase Architecture

The project follows a standard Next.js App Router structure, heavily relying on React Server Components and API Routes.

### Directory Structure

```text
ARA-Dashboard/
├── db/                     # Database schemas and migrations
│   └── migrations/         # .sql files for initializing and updating DB tables
├── docker-entrypoint.sh    # Custom startup script for the Docker container
├── Dockerfile              # Instructions to build the monolithic container
├── next.config.ts          # Next.js configuration
├── package.json            # Project dependencies and scripts
├── scripts/                # Utility scripts (e.g., db-migrate.ts)
└── src/
    ├── animations/         # Framer Motion animation variants
    ├── app/                # Next.js App Router (Pages, Layouts, APIs)
    │   ├── (dashboard)/    # Main authenticated application routes
    │   │   ├── admin/      # Administration views
    │   │   ├── candidate/  # Candidate management
    │   │   ├── company/    # Company/client management
    │   │   ├── lateral/    # Lateral recruitment pipeline
    │   │   ├── executive/  # Executive recruitment pipeline
    │   │   └── consulting/ # Consulting recruitment pipeline
    │   ├── api/            # Backend API endpoints (auth, excel, dataset, cron)
    │   ├── login/          # Authentication page
    │   └── layout.tsx      # Root HTML layout
    ├── assets/             # Static assets like images/icons
    ├── components/         # Reusable React components (UI library, shared widgets)
    ├── hooks/              # Custom React hooks
    ├── lib/                # Core utilities, configuration, and database connection logic
    ├── services/           # Abstractions for external APIs (e.g., Google Drive)
    ├── stores/             # Zustand state stores
    └── types/              # TypeScript interface and type definitions
```

### Key Modules
1. **Authentication (`src/app/api/auth`)**: Handles user login and session management based on the dashboard password and operator allowlists.
2. **Pipelines (`src/app/(dashboard)/*`)**: Distinct views tailored to specific recruitment types (Lateral, Executive, Consulting), rendering data-heavy tables and statistics.
3. **Dataset Manager (`src/app/api/dataset`)**: Integrates with Google Drive and local Excel files to sync and import master workbooks into the system.
4. **Database Migrations (`scripts/db-migrate.ts`)**: A custom TypeScript script that reads `.sql` files from `db/migrations/` and safely applies them to the PostgreSQL database on startup.

---

## 3. Docker Container Deployment

The application is containerized using a single **Dockerfile** that bundles both the Next.js application (Frontend + Backend) and the PostgreSQL database into a single cohesive unit.

### How It Works
- The `Dockerfile` uses a multi-stage build. It first compiles the Next.js application, then creates a final Alpine Linux image.
- Inside the final image, we install PostgreSQL.
- The container uses a custom entrypoint script (`docker-entrypoint.sh`).
- Upon starting, `docker-entrypoint.sh` initializes the Postgres database (if it's empty), creates the necessary users (`ara_user`) and database (`ara_db`), runs the database migrations (`npm run db:migrate`), and finally launches the Next.js application (`npm start`).

### Exposed Ports
The Docker container internally runs two services on the following ports:
- **Port `3000`**: The Next.js web application (Frontend UI & API).
- **Port `5432`**: The PostgreSQL database.

When running the container, you only need to expose port `3000` to the outside world to access the dashboard. Port `5432` can remain internal to the container unless you need to access the database directly from your VPS using a tool like `psql` or pgAdmin.

---

## 4. Running the Container on a VPS

Follow these steps to build and run the ARA Dashboard on your VPS.

### Step 1: Build the Docker Image
Navigate to the root directory of the project (where the `Dockerfile` is located) and run:

```bash
docker build -t ara-dashboard-full .
```

### Step 2: Run the Docker Container
Run the container in detached mode (`-d`). We will map the VPS's port `80` (Standard HTTP) to the container's port `3000` (Next.js). We also use a Docker volume (`ara_pgdata`) to ensure your database data is not lost when the container is stopped or recreated.

```bash
docker run -d \
  --name ara-dashboard \
  --restart unless-stopped \
  -p 80:3000 \
  -v ara_pgdata:/var/lib/postgresql/data \
  -e ARA_DASHBOARD_PASSWORD="your_secure_password" \
  -e ARA_SESSION_SECRET="a_random_secure_string_for_sessions" \
  -e ARA_APP_URL="http://your-vps-ip-or-domain" \
  ara-dashboard-full
```

### Important Environment Variables (`-e`)
You should pass the following variables when running the container (refer to `.env.example` for the full list):
- `ARA_DASHBOARD_PASSWORD`: The password required to log into the dashboard.
- `ARA_SESSION_SECRET`: A secure, random string used to encrypt user sessions.
- `ARA_APP_URL`: The public URL where this dashboard is hosted.
- `ARA_DATASET_SETUP_SECRET`: Required for encrypting dataset configurations.
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`: (Optional) Required if you want to enable the Google Drive/Gmail integrations in production.

*(Note: The internal `POSTGRES_URL` and `ARA_PERSISTENCE` variables are automatically handled by the `docker-entrypoint.sh` script, so you do not need to set them manually when using this monolithic container).*

### Accessing the Dashboard
Once the container is running, you can access the dashboard by visiting your VPS's IP address (or domain name) in a web browser:
**`http://<YOUR_VPS_IP>/`**

### Checking Logs
To check if everything started correctly, view the container logs:
```bash
docker logs -f ara-dashboard
```
You should see output indicating that PostgreSQL has started, migrations have run, and Next.js is listening on port 3000.
