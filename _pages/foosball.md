---
layout: page
permalink: /foosball/
title: foosball
description: CMU foosball Elo ladder
nav: true
nav_order: 7
---

<link rel="stylesheet" href="{{ '/assets/css/foosball.css' | relative_url }}">

<div id="foosball">
  <div class="fb-bar">
    <nav class="fb-nav"></nav>
    <div class="fb-auth"></div>
  </div>
  <p class="fb-flash" hidden></p>
  <div class="fb-view">Loading…</div>
</div>

<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js"></script>
<script src="{{ '/assets/js/foosball/config.js' | relative_url }}"></script>
<script src="{{ '/assets/js/foosball/elo.js' | relative_url }}"></script>
<script src="{{ '/assets/js/foosball/app.js' | relative_url }}"></script>
