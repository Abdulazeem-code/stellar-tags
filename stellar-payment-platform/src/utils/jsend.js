const success = (data) => ({ status: 'success', data });
const fail = (data) => ({ status: 'fail', data });
const error = (message) => ({ status: 'error', message });

module.exports = { success, fail, error };
