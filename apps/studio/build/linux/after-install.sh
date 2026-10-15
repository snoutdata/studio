#!/bin/bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
#---------------------------------------------------------------------------------------------

# Adapted from electron-builder's templates/linux/after-install.tpl (app-builder-lib), which is
# under the MIT License, and ships in the .deb as its postinst. Its notice:
#
#   The MIT License (MIT)
#
#   Copyright (c) 2015 Loopline Systems
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy
#   of this software and associated documentation files (the "Software"), to deal
#   in the Software without restriction, including without limitation the rights
#   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
#   copies of the Software, and to permit persons to whom the Software is
#   furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in all
#   copies or substantial portions of the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
#   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
#   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
#   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
#   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#   SOFTWARE.
#
# Custom .deb postinst. Mirrors electron-builder's stock after-install.tpl (the /usr/bin
# symlink + desktop/MIME refresh) but with one change: we ALWAYS give chrome-sandbox the
# SUID bit (mode 4755). The stock template skips that when the kernel reports working user
# namespaces, but Ubuntu 23.10+ ships userns AND confines it via AppArmor, so Electron still
# falls back to the SUID sandbox and aborts ("chrome-sandbox ... is not configured correctly,
# mode 4755") unless we set it. This is what Chrome's own .deb does.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Always SUID the sandbox helper (see header). chown is implicit: postinst runs as root.
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

# Refreshes the desktop entries.
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
