/*
 * Timekeeper Web Application
 *
 * This file provides all of the client‑side logic for the Timekeeper demo app.
 * Because GitHub Pages only supports static content, the app stores data in
 * the browser's localStorage to simulate a backend. In a production setup
 * you would replace the storage helpers below with calls to a real database
 * such as Firebase, Supabase or a serverless function.
 */

/*
 * Storage abstraction layer.
 *
 * This object abstracts away persistence so the rest of the application can
 * treat all data operations as asynchronous. By default, it uses
 * browser‑localStorage to persist accounts, logs, pay settings and
 * current punch information. If a Firebase configuration is supplied via
 * the global `firebaseConfig` variable, the `init()` method will
 * initialize Firebase and switch to Cloud Firestore for all reads and
 * writes. Firestore provides realtime updates and automatic
 * synchronization across clients, enabling use of the app on multiple
 * devices simultaneously. When no Firebase config is defined, the app
 * continues to function using localStorage, which is sufficient for
 * local testing and offline use.
 */
const Storage = {
    useFirestore: false,
    db: null,
    /**
     * Initialise the storage layer. If a valid firebaseConfig is present
     * on the window and the Firebase libraries have been loaded, this
     * method will initialise Firebase and Cloud Firestore. Otherwise it
     * falls back to localStorage. Must be called before any other
     * storage operation.
     */
    async init() {
        try {
            // Detect whether firebaseConfig has been provided
            if (
                typeof window !== 'undefined' &&
                window.firebaseConfig &&
                window.firebaseConfig.projectId &&
                typeof firebase !== 'undefined' &&
                typeof firebase.initializeApp === 'function'
            ) {
                // Initialise Firebase app only if not already initialised
                if (firebase.apps && firebase.apps.length === 0) {
                    firebase.initializeApp(window.firebaseConfig);
                }
                this.db = firebase.firestore();
                // Enable offline persistence in Firestore. If it fails (e.g. multiple tabs), we ignore the error.
                if (this.db && typeof this.db.enablePersistence === 'function') {
                    try {
                        await this.db.enablePersistence({ synchronizeTabs: true });
                    } catch (err) {
                        console.warn('Firestore persistence could not be enabled:', err);
                    }
                }
                this.useFirestore = true;
            }
        } catch (e) {
            console.warn('Firebase initialisation failed, falling back to localStorage.', e);
            this.useFirestore = false;
        }
        // If not using Firestore ensure localStorage keys exist
        if (!this.useFirestore) {
            if (!localStorage.getItem('accounts')) localStorage.setItem('accounts', JSON.stringify([]));
            if (!localStorage.getItem('logs')) localStorage.setItem('logs', JSON.stringify([]));
            if (!localStorage.getItem('paySettings')) localStorage.setItem('paySettings', JSON.stringify({ startDays: [1, 15] }));
            if (!localStorage.getItem('currentPunch')) localStorage.setItem('currentPunch', JSON.stringify({}));
        }
    },
    /**
     * Ensure the default admin account and default pay period settings
     * exist. This method creates a default administrator account with
     * username/password "admin" if no accounts exist in storage. When
     * using Firestore, this method will create the admin document only
     * once – subsequent calls simply return. With localStorage, it
     * initialises the relevant arrays/objects if they are missing.
     */
    async initDefaults() {
        if (this.useFirestore) {
            const accountsRef = this.db.collection('accounts');
            const snapshot = await accountsRef.limit(1).get();
            if (snapshot.empty) {
                await accountsRef.doc('admin').set({ username: 'admin', password: 'admin', role: 'admin' });
            }
            const settingsDoc = await this.db.collection('settings').doc('paySettings').get();
            if (!settingsDoc.exists) {
                await this.db.collection('settings').doc('paySettings').set({ startDays: [1, 15] });
            }
            // There is no central collection needed for currentPunch; it will be stored per user document when punching
        } else {
            // localStorage fallback handled in init()
            let accounts = JSON.parse(localStorage.getItem('accounts') || '[]');
            if (!accounts || accounts.length === 0) {
                accounts = [];
                accounts.push({ username: 'admin', password: 'admin', role: 'admin' });
                localStorage.setItem('accounts', JSON.stringify(accounts));
            }
            const settings = JSON.parse(localStorage.getItem('paySettings') || 'null');
            if (!settings) {
                localStorage.setItem('paySettings', JSON.stringify({ startDays: [1, 15] }));
            }
        }
    },
    /**
     * Retrieve all accounts. Returns an array of account objects.
     */
    async getAccounts() {
        if (this.useFirestore) {
            const snapshot = await this.db.collection('accounts').get();
            const accounts = [];
            snapshot.forEach(doc => accounts.push(doc.data()));
            return accounts;
        } else {
            return JSON.parse(localStorage.getItem('accounts') || '[]');
        }
    },
    /**
     * Save the entire list of accounts. Only used with localStorage.
     */
    async setAccounts(accounts) {
        if (this.useFirestore) {
            // For Firestore we update each account individually. This method is not
            // used extensively because Firestore writes should be atomic per doc.
            const batch = this.db.batch();
            accounts.forEach(acc => {
                const ref = this.db.collection('accounts').doc(acc.username);
                batch.set(ref, acc);
            });
            await batch.commit();
        } else {
            localStorage.setItem('accounts', JSON.stringify(accounts));
        }
    },
    /**
     * Create or update a single account.
     */
    async upsertAccount(account) {
        if (this.useFirestore) {
            await this.db.collection('accounts').doc(account.username).set(account);
        } else {
            const accounts = JSON.parse(localStorage.getItem('accounts') || '[]');
            const idx = accounts.findIndex(a => a.username === account.username);
            if (idx >= 0) {
                accounts[idx] = account;
            } else {
                accounts.push(account);
            }
            localStorage.setItem('accounts', JSON.stringify(accounts));
        }
    },
    /**
     * Delete an account by username. Also deletes associated logs.
     */
    async deleteAccount(username) {
        if (this.useFirestore) {
            await this.db.collection('accounts').doc(username).delete();
            // delete logs belonging to this user
            const logsRef = this.db.collection('logs');
            const snapshot = await logsRef.where('username', '==', username).get();
            const batch = this.db.batch();
            snapshot.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        } else {
            let accounts = JSON.parse(localStorage.getItem('accounts') || '[]');
            accounts = accounts.filter(a => a.username !== username);
            localStorage.setItem('accounts', JSON.stringify(accounts));
            let logs = JSON.parse(localStorage.getItem('logs') || '[]');
            logs = logs.filter(log => log.username !== username);
            localStorage.setItem('logs', JSON.stringify(logs));
        }
    },
    /**
     * Retrieve all log records. Each record includes: username, date
     * (YYYY‑MM‑DD), punchIn, punchOut, minutesWorked, payPeriodStart and
     * optional deduction.
     */
    async getLogs() {
        if (this.useFirestore) {
            const snapshot = await this.db.collection('logs').get();
            const logs = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                logs.push(Object.assign({ id: doc.id }, data));
            });
            // Sort logs by date ascending for predictable display
            logs.sort((a, b) => a.date.localeCompare(b.date));
            return logs;
        } else {
            return JSON.parse(localStorage.getItem('logs') || '[]');
        }
    },
    /**
     * Add a new log entry. Returns the created entry (with id if using
     * Firestore).
     */
    async addLog(log) {
        if (this.useFirestore) {
            const docRef = await this.db.collection('logs').add(log);
            return Object.assign({ id: docRef.id }, log);
        } else {
            const logs = JSON.parse(localStorage.getItem('logs') || '[]');
            logs.push(log);
            localStorage.setItem('logs', JSON.stringify(logs));
            return log;
        }
    },
    /**
     * Update an existing log entry by its Firestore ID or index in
     * localStorage. For Firestore, logId is the document ID; for
     * localStorage, logId should be the index within the logs array.
     */
    async updateLog(logId, updatedFields) {
        if (this.useFirestore) {
            await this.db.collection('logs').doc(logId).update(updatedFields);
        } else {
            const logs = JSON.parse(localStorage.getItem('logs') || '[]');
            if (logId >= 0 && logId < logs.length) {
                logs[logId] = Object.assign({}, logs[logId], updatedFields);
                localStorage.setItem('logs', JSON.stringify(logs));
            }
        }
    },
    /**
     * Retrieve pay period settings. Returns { startDays: [ ... ] }.
     */
    async getPaySettings() {
        if (this.useFirestore) {
            const doc = await this.db.collection('settings').doc('paySettings').get();
            if (doc.exists) {
                return doc.data();
            }
            return { startDays: [1, 15] };
        } else {
            return JSON.parse(localStorage.getItem('paySettings') || 'null') || { startDays: [1, 15] };
        }
    },
    /**
     * Save pay period settings.
     */
    async setPaySettings(settings) {
        if (this.useFirestore) {
            await this.db.collection('settings').doc('paySettings').set(settings);
        } else {
            localStorage.setItem('paySettings', JSON.stringify(settings));
        }
    },
    /**
     * Retrieve current punch map keyed by username. In Firestore, each
     * employee document stores the current punch under the `currentPunch`
     * field. This method consolidates all such values into a map
     * (username -> { date, punchIn }).
     */
    async getCurrentPunch() {
        if (this.useFirestore) {
            const map = {};
            const accountsSnapshot = await this.db.collection('accounts').get();
            accountsSnapshot.forEach(doc => {
                const data = doc.data();
                if (data.currentPunch) {
                    map[data.username] = data.currentPunch;
                }
            });
            return map;
        } else {
            return JSON.parse(localStorage.getItem('currentPunch') || 'null') || {};
        }
    },
    /**
     * Save the entire currentPunch map (localStorage) or update the
     * currentPunch field of a specific user (Firestore). When using
     * Firestore, pass `username` and `record` to update that user's
     * currentPunch field; passing `record` as null will remove the field.
     */
    async setCurrentPunch(username, record) {
        if (this.useFirestore) {
            const docRef = this.db.collection('accounts').doc(username);
            if (record) {
                await docRef.update({ currentPunch: record });
            } else {
                await docRef.update({ currentPunch: firebase.firestore.FieldValue.delete() });
            }
        } else {
            // localStorage: username should be null when saving entire map
            if (typeof username === 'object' && record === undefined) {
                // storing full object
                localStorage.setItem('currentPunch', JSON.stringify(username));
            } else {
                // storing per user
                const map = JSON.parse(localStorage.getItem('currentPunch') || 'null') || {};
                if (record) {
                    map[username] = record;
                } else {
                    delete map[username];
                }
                localStorage.setItem('currentPunch', JSON.stringify(map));
            }
        }
    }
};


// Time helper: convert HH:MM string to minutes after midnight
function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}
// Convert minutes to HH:MM string (zero padded)
function minutesToTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Compute pay period start date given a Date object and an array of
// start days. This helper does not perform any asynchronous
// operations. If no startDays array is provided it falls back to the
// default [1,15].
function getPayPeriodStart(dateObj, startDaysParam) {
    const startDays = (startDaysParam ?? [1, 15]).slice().sort((a, b) => a - b);
    const day = dateObj.getDate();
    const month = dateObj.getMonth();
    const year = dateObj.getFullYear();
    let chosenDay = null;
    for (let i = 0; i < startDays.length; i++) {
        if (day >= startDays[i]) {
            chosenDay = startDays[i];
        }
    }
    if (chosenDay === null) {
        // use last start day of previous month
        const prevMonth = (month - 1 + 12) % 12;
        const prevYear = month === 0 ? year - 1 : year;
        const lastDay = startDays[startDays.length - 1];
        const daysInPrevMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
        const startDate = new Date(prevYear, prevMonth, Math.min(lastDay, daysInPrevMonth));
        return startDate.toISOString().slice(0, 10);
    } else {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const actualDay = Math.min(chosenDay, daysInMonth);
        const startDate = new Date(year, month, actualDay);
        return startDate.toISOString().slice(0, 10);
    }
}

// Compute worked minutes between an actual punch‑in and punch‑out time.
// Both arguments should be strings in "HH:MM" format. If a deduction
// value (in minutes) is provided, it will be subtracted from the
// total. The result will never be negative.
function computeWorkedMinutes(actualIn, actualOut, deduction = 0) {
    const ai = timeToMinutes(actualIn);
    const ao = timeToMinutes(actualOut);
    let minutes = ao - ai;
    if (minutes < 0) {
        // If the shift crosses midnight we simply treat it as zero. A
        // more robust implementation could add 24*60 minutes but that
        // behaviour is not needed for this demo.
        minutes = 0;
    }
    minutes -= deduction;
    if (minutes < 0) minutes = 0;
    return minutes;
}

// Format minutes into hours with two decimal places
function formatHours(mins) {
    return (mins / 60).toFixed(2);
}

// Update UI helper functions
function show(element) { element.classList.remove('hidden'); }
function hide(element) { element.classList.add('hidden'); }

// Populate employees table in admin view
function refreshEmployeeTable() {
    const tbody = document.querySelector('#employees-table tbody');
    tbody.innerHTML = '';
    // Fetch accounts asynchronously and then render the table
    (async () => {
        const accounts = await Storage.getAccounts();
        accounts.forEach(acc => {
            if (acc.role === 'employee') {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${acc.username}</td>
                    <td>${acc.hourlyRate ?? ''}</td>
                    <td>
                        <button class="delete-btn" data-username="${acc.username}">Delete</button>
                    </td>
                `;
                tbody.appendChild(tr);
            }
        });
        // attach delete handlers
        tbody.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const username = this.dataset.username;
                if (username && confirm(`Delete employee '${username}'? This will remove all their logs.`)) {
                    await Storage.deleteAccount(username);
                    refreshEmployeeTable();
                    refreshLogsTable();
                }
            });
        });
    })();
}

// Populate logs table (admin view)
async function refreshLogsTable() {
    const tbody = document.querySelector('#logs-table tbody');
    tbody.innerHTML = '';
    const logs = await Storage.getLogs();
    logs.forEach((log, index) => {
        // Determine the unique identifier for this log for update operations
        const rowId = Storage.useFirestore ? log.id : index;
        const deduction = log.deduction ?? 0;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${log.username}</td>
            <td>${log.date}</td>
            <td>${log.punchIn}</td>
            <td>${log.punchOut}</td>
            <td>${formatHours(log.minutesWorked)}</td>
            <td>${log.payPeriodStart}</td>
            <td><input type="number" class="deduct-input" data-id="${rowId}" value="${deduction}" min="0" style="width:80px"></td>
            <td><button class="save-deduct-btn" data-id="${rowId}">Save</button></td>
        `;
        tbody.appendChild(tr);
    });
    // attach save handlers
    tbody.querySelectorAll('.save-deduct-btn').forEach(btn => {
        btn.addEventListener('click', async function() {
            const id = this.dataset.id;
            const input = tbody.querySelector(`input.deduct-input[data-id="${id}"]`);
            const value = parseInt(input.value);
            const deduction = isNaN(value) || value < 0 ? 0 : value;
            // Find corresponding log to compute new minutes
            const logsAll = logs; // closure variable from above
            // Determine index for localStorage or find by id for Firestore
            let logIndex;
            let logRecord;
            if (Storage.useFirestore) {
                logRecord = logsAll.find(l => l.id === id);
            } else {
                logIndex = parseInt(id);
                logRecord = logsAll[logIndex];
            }
            if (!logRecord) return;
            const minutes = computeWorkedMinutes(logRecord.punchIn, logRecord.punchOut, deduction);
            // Update minutesWorked and deduction
            if (Storage.useFirestore) {
                await Storage.updateLog(id, { minutesWorked: minutes, deduction });
            } else {
                await Storage.updateLog(logIndex, { minutesWorked: minutes, deduction });
            }
            // Refresh tables and summary after update
            refreshLogsTable();
            refreshSummaryTable();
        });
    });
}

// Generate summary for admin view
async function generateSummary() {
    const logs = await Storage.getLogs();
    const accounts = await Storage.getAccounts();
    // Build a map payPeriodStart -> employee -> totalMinutes
    const summaryMap = {};
    logs.forEach(log => {
        if (!summaryMap[log.payPeriodStart]) summaryMap[log.payPeriodStart] = {};
        const empMap = summaryMap[log.payPeriodStart];
        if (!empMap[log.username]) empMap[log.username] = 0;
        empMap[log.username] += log.minutesWorked;
    });
    // Create rows
    const summaryRows = [];
    Object.keys(summaryMap).sort().forEach(period => {
        const empMap = summaryMap[period];
        Object.keys(empMap).forEach(user => {
            const totalMins = empMap[user];
            const account = accounts.find(a => a.username === user);
            const rate = account?.hourlyRate || 0;
            const totalPay = (totalMins / 60 * rate).toFixed(2);
            summaryRows.push({ period, user, totalHours: formatHours(totalMins), totalPay });
        });
    });
    return summaryRows;
}

// Populate summary table and show export button
async function refreshSummaryTable() {
    const tbody = document.querySelector('#summary-table tbody');
    tbody.innerHTML = '';
    const rows = await generateSummary();
    rows.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${row.period}</td>
            <td>${row.user}</td>
            <td>${row.totalHours}</td>
            <td>${row.totalPay}</td>
        `;
        tbody.appendChild(tr);
    });
    const summaryTable = document.querySelector('#summary-table');
    const exportBtn = document.querySelector('#export-summary-button');
    if (rows.length > 0) {
        show(summaryTable);
        show(exportBtn);
    } else {
        hide(summaryTable);
        hide(exportBtn);
    }
}

// Export summary to CSV and download
async function exportSummary() {
    const rows = await generateSummary();
    if (!rows || rows.length === 0) {
        alert('No summary data to export.');
        return;
    }
    let csv = 'Pay Period Start,Employee,Total Hours,Total Pay\n';
    rows.forEach(r => {
        csv += `${r.period},${r.user},${r.totalHours},${r.totalPay}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'timekeeper_summary.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 0);
}

// Populate an employee's history table. This function retrieves
// all logs from storage asynchronously, filters them for the
// specified username and then renders a row for each entry. The
// deduction value is displayed but cannot be edited by the employee.
function refreshHistoryTable(username) {
    const tbody = document.querySelector('#history-table tbody');
    tbody.innerHTML = '';
    (async () => {
        const logs = await Storage.getLogs();
        logs.filter(log => log.username === username).forEach(log => {
            const deduction = log.deduction ?? 0;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${log.date}</td>
                <td>${log.punchIn}</td>
                <td>${log.punchOut}</td>
                <td>${formatHours(log.minutesWorked)}</td>
                <td>${log.payPeriodStart}</td>
                <td>${deduction}</td>
            `;
            tbody.appendChild(tr);
        });
    })();
}

// DOMContentLoaded – start everything
document.addEventListener('DOMContentLoaded', () => {
    // Initialise storage before any operations. We wrap in an
    // immediately invoked async function because DOMContentLoaded
    // handlers cannot be declared async directly.
    (async () => {
        await Storage.init();
        await Storage.initDefaults();
    })();
    // Grab references to DOM elements
    const loginSection = document.getElementById('login-section');
    const employeeSection = document.getElementById('employee-section');
    const adminSection = document.getElementById('admin-section');
    const loginButton = document.getElementById('login-button');
    const loginError = document.getElementById('login-error');
    const loginUsername = document.getElementById('login-username');
    const loginPassword = document.getElementById('login-password');
    const loginRole = document.getElementById('login-role');

    // Employee view elements
    const employeeWelcome = document.getElementById('employee-welcome');
    const shiftInfo = document.getElementById('shift-info');
    const punchInBtn = document.getElementById('punch-in-button');
    const punchOutBtn = document.getElementById('punch-out-button');
    const punchMessage = document.getElementById('punch-message');
    const viewHistoryBtn = document.getElementById('view-history-button');
    const historySection = document.getElementById('history-section');
    const employeeLogoutBtn = document.getElementById('employee-logout-button');

    // Admin view elements
    const adminLogoutBtn = document.getElementById('admin-logout-button');
    const addEmployeeBtn = document.getElementById('add-employee-button');
    const addEmployeeError = document.getElementById('add-employee-error');
    const newEmpUsername = document.getElementById('new-emp-username');
    const newEmpPassword = document.getElementById('new-emp-password');
    const newEmpRate = document.getElementById('new-emp-rate');
    // Shift start/end inputs have been removed; employees determine their
    // shift boundaries by punching in and out. The variables below are
    // placeholders to avoid reference errors in older code.
    const newEmpShiftStart = null;
    const newEmpShiftEnd = null;
    const payPeriodDaysInput = document.getElementById('pay-period-days');
    const savePayPeriodBtn = document.getElementById('save-pay-period');
    const payPeriodMessage = document.getElementById('pay-period-message');
    const generateSummaryBtn = document.getElementById('generate-summary-button');
    const exportSummaryBtn = document.getElementById('export-summary-button');

    let currentUser = null;

    // Display correct view after login
    function loadEmployeeView(account) {
        currentUser = account;
        loginSection.classList.add('hidden');
        adminSection.classList.add('hidden');
        employeeSection.classList.remove('hidden');
        employeeWelcome.textContent = `Welcome, ${account.username}!`;
        // Inform the employee how their hours are recorded. Shifts are no longer
        // pre‑scheduled; instead, time is calculated from punch in to punch out.
        shiftInfo.textContent = 'Your hours will be recorded from when you punch in until you punch out.';
        // Determine if currentPunch exists for this user. Fetch asynchronously
        (async () => {
            const currentPunchMap = await Storage.getCurrentPunch();
            const today = new Date().toISOString().slice(0, 10);
            if (currentPunchMap[currentUser.username] && currentPunchMap[currentUser.username].date === today) {
                // Already punched in
                hide(punchInBtn);
                show(punchOutBtn);
                const time = currentPunchMap[currentUser.username].punchIn;
                punchMessage.textContent = `You punched in at ${time}.`;
            } else {
                // Not punched in yet
                show(punchInBtn);
                hide(punchOutBtn);
                punchMessage.textContent = '';
            }
        })();
        hide(historySection);
    }

    function loadAdminView(account) {
        currentUser = account;
        loginSection.classList.add('hidden');
        employeeSection.classList.add('hidden');
        adminSection.classList.remove('hidden');
        // Populate existing settings asynchronously
        (async () => {
            try {
                const settings = await Storage.getPaySettings();
                payPeriodDaysInput.value = settings.startDays.join(',');
            } catch (e) {
                payPeriodDaysInput.value = '1,15';
            }
        })();
        // Refresh tables
        refreshEmployeeTable();
        refreshLogsTable();
        hide(document.getElementById('summary-table'));
        hide(document.getElementById('export-summary-button'));
    }

    // Handle login
    loginButton.addEventListener('click', () => {
        const username = loginUsername.value.trim();
        const password = loginPassword.value;
        const role = loginRole.value;
        (async () => {
            const accounts = await Storage.getAccounts();
            const account = accounts.find(acc => acc.username === username && acc.password === password && acc.role === role);
            if (!account) {
                loginError.textContent = 'Invalid credentials or role.';
                return;
            }
            loginError.textContent = '';
            if (account.role === 'employee') {
                loadEmployeeView(account);
            } else if (account.role === 'admin') {
                loadAdminView(account);
            }
            // Clear login fields
            loginUsername.value = '';
            loginPassword.value = '';
        })();
    });

    // Employee punch in
    punchInBtn.addEventListener('click', () => {
        (async () => {
            const now = new Date();
            const timeStr = now.toTimeString().slice(0, 5);
            const today = now.toISOString().slice(0, 10);
            const record = { date: today, punchIn: timeStr };
            if (Storage.useFirestore) {
                await Storage.setCurrentPunch(currentUser.username, record);
            } else {
                const currentPunchMap = await Storage.getCurrentPunch();
                currentPunchMap[currentUser.username] = record;
                await Storage.setCurrentPunch(currentPunchMap);
            }
            hide(punchInBtn);
            show(punchOutBtn);
            punchMessage.textContent = `You punched in at ${timeStr}.`;
        })();
    });

    // Employee punch out
    punchOutBtn.addEventListener('click', () => {
        // Convert this handler into an asynchronous routine using an
        // immediately invoked async function. This allows us to
        // retrieve current punch information and pay settings from
        // storage regardless of whether Firestore or localStorage is in use.
        (async () => {
            const now = new Date();
            const timeOutStr = now.toTimeString().slice(0, 5);
            const today = now.toISOString().slice(0, 10);
            // Retrieve the current punch map and locate this user's record
            const currentPunchMap = await Storage.getCurrentPunch();
            const punchRecord = currentPunchMap[currentUser.username];
            if (!punchRecord || punchRecord.date !== today) {
                alert('No punch in record found for today.');
                return;
            }
            const timeInStr = punchRecord.punchIn;
            // Determine minutes worked based solely on actual punch times.
            const minutesWorked = computeWorkedMinutes(timeInStr, timeOutStr);
            // Retrieve pay settings to determine the pay period start
            let startDays;
            try {
                const settings = await Storage.getPaySettings();
                startDays = settings.startDays;
            } catch (e) {
                startDays = [1, 15];
            }
            const payPeriodStart = getPayPeriodStart(now, startDays);
            // Persist the log entry
            await Storage.addLog({
                username: currentUser.username,
                date: today,
                punchIn: timeInStr,
                punchOut: timeOutStr,
                minutesWorked,
                payPeriodStart
            });
            // Remove current punch for this user
            if (Storage.useFirestore) {
                await Storage.setCurrentPunch(currentUser.username, null);
            } else {
                delete currentPunchMap[currentUser.username];
                await Storage.setCurrentPunch(currentPunchMap);
            }
            // Update the UI
            show(punchInBtn);
            hide(punchOutBtn);
            punchMessage.textContent = `You punched out at ${timeOutStr}. Total worked: ${formatHours(minutesWorked)} hours.`;
            // Refresh logs and summary so administrators see the latest data
            refreshLogsTable();
            refreshSummaryTable();
        })();
    });

    // View history
    viewHistoryBtn.addEventListener('click', () => {
        if (historySection.classList.contains('hidden')) {
            refreshHistoryTable(currentUser.username);
            show(historySection);
            viewHistoryBtn.textContent = 'Hide History';
        } else {
            hide(historySection);
            viewHistoryBtn.textContent = 'View History';
        }
    });

    // Employee logout
    employeeLogoutBtn.addEventListener('click', () => {
        currentUser = null;
        hide(employeeSection);
        show(loginSection);
        historySection.classList.add('hidden');
        viewHistoryBtn.textContent = 'View History';
    });

    // Admin logout
    adminLogoutBtn.addEventListener('click', () => {
        currentUser = null;
        hide(adminSection);
        show(loginSection);
    });

    // Add employee
    addEmployeeBtn.addEventListener('click', async () => {
        const username = newEmpUsername.value.trim();
        const password = newEmpPassword.value;
        const rate = parseFloat(newEmpRate.value);
        // Validate fields
        if (!username || !password || isNaN(rate)) {
            addEmployeeError.textContent = 'Please enter a username, password and hourly rate.';
            return;
        }
        const accounts = await Storage.getAccounts();
        if (accounts.some(acc => acc.username === username)) {
            addEmployeeError.textContent = 'Username already exists.';
            return;
        }
        // Persist new employee. Shift start and end are not stored because
        // shifts are defined by punch in/out times.
        await Storage.upsertAccount({ username, password, role: 'employee', hourlyRate: rate });
        // Clear inputs
        newEmpUsername.value = '';
        newEmpPassword.value = '';
        newEmpRate.value = '';
        addEmployeeError.textContent = '';
        refreshEmployeeTable();
    });

    // Save pay period settings
    savePayPeriodBtn.addEventListener('click', () => {
        (async () => {
            const input = payPeriodDaysInput.value.trim();
            const parts = input.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 1 && n <= 31);
            if (parts.length === 0) {
                payPeriodMessage.textContent = 'Please enter valid day numbers separated by commas.';
                return;
            }
            parts.sort((a, b) => a - b);
            await Storage.setPaySettings({ startDays: parts });
            payPeriodMessage.textContent = 'Pay period settings saved.';
        })();
    });

    // Generate summary button
    generateSummaryBtn.addEventListener('click', () => {
        refreshSummaryTable();
    });

    // Export summary
    exportSummaryBtn.addEventListener('click', () => {
        exportSummary();
    });
});