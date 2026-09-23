// OpenVibe.VIP — progressive touches only; every page and form works without this file.
(function () {
    'use strict';
    document.documentElement.classList.add('js');
    document.addEventListener('DOMContentLoaded', function () {
        // Dashboard rule form: show the plan/perk pickers only for the requirement that uses them.
        var form = document.querySelector('form[action$="/rules"]');
        if (!form) return;
        var req = form.querySelector('select[name=requirement]');
        var plan = form.querySelector('select[name=plan_id]');
        var perk = form.querySelector('select[name=perk_key]');
        function sync() {
            if (plan) plan.closest('label').hidden = req.value !== 'plan';
            if (perk) perk.closest('label').hidden = req.value !== 'perk';
        }
        if (req) { req.addEventListener('change', sync); sync(); }
    });
})();
