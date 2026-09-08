#!/bin/bash
# Launcher for the LinkedIn scraper microservice.
# Runs python_service.py with the user pip installed deps + correct
# environment. Logs go to /var/www/myapp/job-apply/server/logs/.
#
# Edit PYTHON_BIN if your interpreter isn't /usr/bin/python3.

set -e

cd "$(dirname "$0")"

mkdir -p /var/www/myapp/job-apply/server/logs

# Use the user-installed pip bootstrap that found the system flask +
# playwright. Without --break-system-packages PEP 668 blocks it; this
# only affects this process and its children.
exec /usr/bin/python3 /var/www/myapp/job-apply/server/services/scraper/python_service.py
