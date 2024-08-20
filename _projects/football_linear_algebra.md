---
layout: page
title: Football with Linear Algebra
description: Predict NFL playoffs using Linear Algebra
img: assets/img/Football.jpg
importance: 3
category: course project
---

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/football_pic.jpg"  width="50%" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<a class="text" href="/assets/pdf/Linear.pdf">[Full Writeup]</a>
Partner: [Eric Gan](https://www.linkedin.com/in/eric-gan-cmu/)

This was a course project from when I took Matrix Algebra at CMU in 2019. The main goal of this project was to take data from the regular season of the NFL and predict the playoffs be computing rankings for each team.

# Implementation

We employed two main strategies:

1.  In the first, we try to find rankings of teams, such
that for every game between teams i and j, the difference between team
i's score and team j's score is equal to their difference in ranking. This method didn't work
well at first, but after taking all nonzero terms in our matrix and making them small values
10^(-15) it was very efficient. We surmise that this is because we were able to increase the
stability of the matrix through perturbation<

2. In the next method, we created a matrix that is 32 by 32, such that every entry Aij is equal to
the total number of points scored by team i against team j,
with some normalization. Next, we tried to find some strength vector S such that,
when multiplying A by S, we get a vector proportional to S. This becomes an equation where we
can use eigenvalues and eigenvectors to find a solution. It
worked better than a naive version of strategy 1, but worse than the perturbed values.