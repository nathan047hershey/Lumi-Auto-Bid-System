# How to Install RabbitMQ on Windows

## Option 1: Manual Installation (Recommended)

### 1. Download Erlang
1. Go to: https://www.erlang.org/downloads
2. Download **OTP 27.x.x Windows 64-bit** 
3. Run the installer (click Next until done)

### 2. Download RabbitMQ
1. Go to: https://www.rabbitmq.com/install-windows.html
2. Download **rabbitmq-server-3.x.x.exe**
3. Run the installer (click Next until done)

### 3. Enable Management Plugin
Open Command Prompt and run:
```cmd
"C:\Program Files\RabbitMQ Server\rabbitmq_server-3.13.x\sbin\rabbitmq-plugins.bat" enable rabbitmq_management
```

### 4. Start RabbitMQ
Open Command Prompt and run:
```cmd
"C:\Program Files\RabbitMQ Server\rabbitmq_server-3.13.x\sbin\rabbitmq-server.bat"
```

You should see:
```
Starting broker... completed with 0 plugins.
```

---

## Option 2: Using Chocolatey (if you install it)

1. Install Chocolatey:
   ```
   powershell -Command "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))"
   ```

2. Install RabbitMQ:
   ```
   choco install rabbitmq -y
   ```

3. Enable management:
   ```
   rabbitmq-plugins enable rabbitmq_management
   ```

4. Start RabbitMQ:
   ```
   rabbitmq-server
   ```

---

## Option 3: Using Docker (if you install Docker Desktop)

1. Install Docker Desktop: https://www.docker.com/products/docker-desktop/

2. Run RabbitMQ in Docker:
   ```cmd
   docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
   ```

3. Access management UI at: http://localhost:15672
   - Username: guest
   - Password: guest

---

## After Installing RabbitMQ

1. Make sure RabbitMQ is running
2. Restart your app:
   ```bash
   npm run dev
   ```

3. You should see:
   ```
   [resumeQueue] connected to amqp://guest:guest@localhost:5672
   [autoApply] cron started...
   ```

4. The RabbitMQ Management UI will be at: http://localhost:15672
   - Username: guest
   - Password: guest

---

## Verify RabbitMQ is Running

```cmd
netstat -an | findstr 5672
```

You should see:
```
TCP    0.0.0.0:5672    LISTENING
```
