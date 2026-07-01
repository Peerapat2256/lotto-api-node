# Lottery API Server

The backend REST API server for the lottery mobile application, built with Node.js, Express, and MySQL.

## Features

* **JWT Authentication**: User authentication and secure endpoint access using JSON Web Tokens.
* **Password Hashing**: Secure user registration with bcrypt password encryption.
* **Database Integration**: MySQL integration via mysql2 for lottery ticket records, user management, and purchase tracking.
* **REST API Endpoints**: Endpoints for lottery searches, cart management, and prize verification.

## How to Run

### Prerequisites
* Node.js and npm installed.
* MySQL database server configured.

### Installation and Execution

1. Configure environment settings in your `.env` file (e.g. database credentials, JWT secret key).

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the development server:
   ```bash
   npm run dev
   ```

4. Run the production server:
   ```bash
   npm start
   ```
