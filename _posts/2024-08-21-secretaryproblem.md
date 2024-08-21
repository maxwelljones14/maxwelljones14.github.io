---
layout: distill
title: Secretary Problem Variant Deep Dive
description: A deep dive into a variant of the secretary problem - no prereading required!
tags: math
giscus_comments: true
date: 2024-08-20
featured: true

authors:
  - name: Maxwell Jones
    url: "maxwelljon.es"
    affiliations:
      name: CMU
  - name: Advait Nene
    url: "https://www.linkedin.com/in/advait-nene-anene/"
    affiliations:
      name: CMU

bibliography: 2024-08-21-secretaryproblem.bib

# # Optionally, you can add a table of contents to your post.
# # NOTES:
# #   - make sure that TOC names match the actual section names
# #     for hyperlinks within the post to work correctly.
# #   - we may want to automate TOC generation in the future using
# #     jekyll-toc plugin (https://github.com/toshimaru/jekyll-toc).
toc:
  - name: Introduction
  - name: Solution to the "Discrete Expected Secretary Problem"
    subsections:
      - name: Formal Setup/Ideas
      - name: Expectation Calculation
      - name: Visualizations/Intuition
#     # if a section has subsections, you can add them as follows:
#     # subsections:
#     #   - name: Example Child Subsection 1
#     #   - name: Example Child Subsection 2
---

## Introduction

The [secretary problem](https://en.wikipedia.org/wiki/Secretary_problem) (sometimes called the marriage problem) is a famous algorithmic puzzle with applications in social decision making. I've taken the initial problem setup from another [great article](https://www.cantorsparadise.com/math-based-decision-making-the-secretary-problem-a30e301d8489)<d-footnote>I highly recommend reading that article if you are unfamiliar with the problem or it's original solution</d-footnote> on the topic:

*You are the HR manager of a company and need to hire the best secretary out of a given number N of candidates. You can interview them one by one, in random order. However, the decision of appointing or rejecting a particular applicant must be taken immediately after the interview. If nobody has been accepted before the end, the last candidate is chosen.*

At this point, the following question is usually asked:

*What strategy do you use to maximize the chances to hire the best applicant?*

The well known solution to the problem (as $$N$$ goes to infinity) is as follows: 
- Reject the first $$\frac{N}{e}$$ secretaries where $$e$$ is Eulers number, and note down the best out of this group as $$\text{init}_{\max}$$
- Hire the first secretary after that point that is better than $$\text{init}_{\max}$$

 While this may be an interesting question, it falls short of the real world scenario we are trying to model here in our opinion. If the secretaries are randomly distributed, the second best secretary out of the $$N$$ should also be a pretty good hire, and same for the third best. In fact, a strategy that picks the best secretary 10 percent of the time and the worst secretary every other time should really be deemed worse than one that picks the best secretary 9 percent of the time and the second best the other 91 percent. 

 Our previous musings lead to the idea of trying to maximize the best secretary 
 **_in expectation_**, where the best secretary of the group has the highest value of $$N$$, the second best $$N - 1$$, and so on until the worst secretary with a score of 1. This may yield different results to the more famous setup where the probability of picking the best secretary is maximized. We will call this the **Discrete Expected Secretary Problem**

---

## Solution to the "Discrete Expected Secretary Problem"
### Formal Setup/Ideas
Formally, we will consider a set of $$N$$ secretaries with distinct scores from 1 to $$N$$, and order them randomly<d-footnote>A similar problem with expectation was solved by Bearden<d-cite key="bearden2006new"></d-cite>, in which each secretary's score is independently uniformly distributed between 0 and 1. This is a similar, but not identical formulation since ours has exactly 1 person at each score level between 1 and N, which will yield some nice combinatorial results.</d-footnote>. We will use the strategy of passing on some fixed number $$k$$ secretaries then picking the next one better than all those we passed on, with $$k_{\text{opt}}$$ being the optimal value for highest expected return.

If we can write the expected value in terms of $$k$$, i.e. 

$$
\begin{equation}
        \label{eq:goal}
      \mathbb{E}[\text{Secretary chosen}] = f(k)
  \end{equation}
$$

then we can simply differentiate with respect to $$k$$ and find the max by setting the derivative equal to zero. Let's try that. From here on, $$k$$ represents the number of secretaries we reject in part one of the algorithm.

### Expectation Calculation
To tackle this problem, we will use the law of total expectation, and partition our possibilities based on the score of $$\text{init}_{\max}$$, the best secretary from the initial rejected group. Notice that this value must be at least $k$, since the initial group has $k$ secretaries:

$$
\begin{equation}
    \label{eq:total_prob}
    \mathbb{E}[\text{Secretary chosen}] = \sum_{i = k}^N \mathbb{P}[\text{init}_{\max} = i]\mathbb{E}[\text{Secretary chosen} | \text{init}_{\max} = i]
\end{equation}
$$

From here, notice that calculating $$\mathbb{E}[\text{Secretary chosen} | \text{init}_{\max} = i]$$ is relatively easy. 
- If $$\text{init}_{\max} = N$$, then the best secretary was in the rejecting group, and we are forced to choose the last secretary in the list of $$N$$. The last secretary is distributed randomly between the worst and second best in this case (since the best is in the initial $k$), so the expected value is $$\frac{1 + (N - 1)}{2} = \frac{N}{2}$$
- If $$\text{init}_{\max} = N$$, then the best secretary was in the rejecting group, and we are forced to choose the last secretary in the list of $$N$$. The last secretary is distributed randomly between the worst and second best in this case (since the best is in the initial $k$), so the expected value is $$\frac{1 + (N - 1)}{2} = \frac{N}{2}$$

These thoughts lead us to the new equation of:

$$
\begin{equation}
\label{eq:total_prob_simp}
\mathbb{E}[\text{Secretary chosen}] = \mathbb{P}[\text{init}_{\max} = N]\frac{N}{2} + \sum_{i = k}^{N - 1} \mathbb{P}[\text{init}_{\max} = i]\frac{i + 1 + N}{2}    
\end{equation}
$$

We can again simplify, since the probability that $$\text{init}_{\max} = N$$ (i.e. the best secretary of the first $$k$$ is $$N$$ ) is simply the probability that the best secretary (with score $$N$$) is in the first $$k$$. Since everyone is randomly distributed, this occurs with probability $$\frac{k}{N}$$:

$$
\begin{equation}
\label{eq:top_prob}
    \mathbb{P}[\text{init}_{\max} = N] = \mathbb{P}[\text{the top secretary is in the first $k$}] = \frac{k}{N}
\end{equation}
$$

We now have:

$$
\begin{equation}
    \mathbb{E}[\text{Secretary chosen}] = \frac{k}{N}\frac{N}{2} + \sum_{i = k}^{N - 1} \mathbb{P}[\text{init}_{\max} = i]\frac{i + 1 + N}{2}
\end{equation}
$$
$$
\begin{equation}
    \label{eq:total_prob_more_simp}
    \mathbb{E}[\text{Secretary chosen}] = \frac{k}{2} + \sum_{i = k}^{N - 1} \mathbb{P}[\text{init}_{\max} = i]\frac{i + 1 + N}{2}
\end{equation}
$$

What's left is to determine $$\mathbb{P}[\text{init}_{\max} = i]$$ in the other cases, and turn this whole thing into closed form. Here we will turn to combinatorics. 

Note that the total number of ways to arrange $$N$$ secretaries is $$N!$$. Let's now count the number of ways in which $$\text{init}_{\max} = i$$:

$$
\begin{equation}
    \label{eq:combinatorics_1}
    \underbrace{k}_{\text{put $i$ in the first $k$}}*\underbrace{(i - 1)*\dots*(i - (k - 1))}_{\text{fill other $k - 1$ with secretaries worse than $i$}}*\underbrace{(N - k)*\dots
*(1)}_{\text{fill rest}}
\end{equation}
$$

Since the secretaries are randomly distributed, each permutation has an equal probability, leading to a result of:

$$
\begin{equation}
\label{eq:combinatorics_prob_setup}
    \mathbb{P}[\text{init}_{\max} = i] = \frac{k(i - 1)\dots(i - (k - 1))((N - k)\dots(1))}{N!}
\end{equation}
$$

From here we can finally write the expected value of the secretary chosen for an arbitrary stopping point $$k$$ as 

$$
\begin{equation}
    \label{eq:first_exp_no_simplify}
    \frac{k}{2} + \sum_{i = k}^{N - 1}\frac{k(i - 1)\dots(i - (k - 1))((N - k)\dots(1))}{N!}\frac{i + 1 + N}{2}
\end{equation}
$$

Luckily, the result simplifies nicely into 

$$
\begin{equation}
    \label{eq:exp_simple}
    \frac{k}{2} + \frac{N - k}{2}\left(\frac{N + 1}{N} + \frac{k}{k + 1}\right) \\
\end{equation}
$$

{% details Click here for the full proof (slightly involved) %}
First, our ugly combinatorial term can actually be simplified as follows:
$$
\label{app:simplification}
\begin{equation}
\frac{k(i - 1)\dots(i - (k - 1))((N - k)\dots(1))}{N!} = \frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}
\end{equation}
$$
{% details Click here for the full subproof of this fact%}
$$
\label{subsec_init_proof}
\begin{align*}
    & \frac{k(i - 1)\dots(i - (k - 1))((N - k)\dots(1))}{N!} \\
    = & \frac{k}{N}\frac{\frac{(i - 1)!}{(i - k)!}(N - k)!}{(N - 1)!} \\
    = & \frac{k}{N}\frac{\frac{(i - 1)!}{(i - k)!}}{\frac{(N - 1)!}{(N - k)!}} \\
    = & \frac{k}{N}\frac{\frac{(i - 1)!}{(i - k)!(k - 1)!}}{\frac{(N - 1)!}{(N - k)!(k - 1)!}} \\
    = & \frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}} \\
\end{align*}
$$
{% enddetails %}
We're now trying to simplify the prettier equation: 

$$
\begin{equation} 
\frac{k}{2} + \sum_{i = k}^{N - 1}\frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}\frac{i + 1 + N}{2}
\end{equation}
$$

Next, note that in every assignment, $$\text{init}_{\max}$$ must be a value between $$k$$ and $$N$$. As a result, the sum of probabilities of $$\text{init}_{\max} = i$$ for $$i$$ between $$k$$ and $$N$$ must add to 1. We have that:

$$
\begin{equation}
\label{eq:identity_messy}
    1 = \sum_{i = k}^N \mathbb{P}[\text{init}_{\max} = i] = \sum_{i = k}^N \frac{k(i - 1)\dots(i - (k - 1))((N - k)\dots(1))}{N!}
\end{equation}
$$

using Equation (11), this yeilds

$$
 1 = \sum_{i = k}^N \frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}
$$

moving around some terms, we have that:

$$
\begin{equation}
    \label{eq:identity}
    \frac{N - k}{k} = \sum_{i = k}^{N - 1}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}
\end{equation}
$$
{% details Click here for the full subproof of moving around terms%}
$$
\label{subsec_init_proof_second}
\begin{align*}
    & 1 =  \sum_{i = k}^N \frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}} \\
    \implies & \frac{N}{k} = \sum_{i = k}^N\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}} \\
    \implies & \frac{N}{k} = \sum_{i = k}^{N - 1}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}} + 1 \\
    \implies & \frac{N - k}{k} = \sum_{i = k}^{N - 1}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}
\end{align*}
$$
{% enddetails %}

Via a similar process where we reject the first $$k + 1$$ secretaries, we arrive at

$$
\begin{equation}
    \label{eq:surprise_tool}
    \frac{N(N - k)}{k + 1} = \sum_{i = k}^{N - 1} i\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}
\end{equation}
$$

{% details Click here for fully worked out similar process%}
Let's consider rejecting the first $$k + 1$$ secretaries, and finding the probability that secretary $$i + 1$$ is the best secretary in this group. We can count the number of ways this happens: 

$$
\begin{equation}
    \label{eq:combinatorics_app_1}
    \underbrace{k + 1}_{\text{put $i + 1$ in the first $k + 1$}}*\underbrace{(i)*\dots*(i - (k - 1))}_{\text{fill other $k$ with secretaries worse than $i + 1$}}*\underbrace{(N - (k + 1))*\dots
*(1)}_{\text{fill rest}}
\end{equation}
$$

Again we can denote the probability of the $$i + 1$$th person being the best in the group as the quotient of this and $$N!$$, yielding:

$$
\begin{align*}
    & \frac{(k + 1)(i)\dots(i - (k - 1))(N - (k + 1)))\dots(1)}{N!} \\
    = & \frac{(k + 1)i}{k(n - k)}\frac{k(i - 1)\dots(i - (k - 1))((N - (k + 1))\dots(1))}{N!} \\
    = & \frac{(k + 1)i}{k(n - k)} \frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}} && \text{Equation (11)}
\end{align*}
$$

Again, since the sum of these probabilities from $$i + 1 = k + 1$$ to $$i + 1 = N$$ covers all possible top rejecting people, we have that:

$$
\begin{equation}
    \sum_{i = k}^{N - 1} \frac{(k + 1)i}{k(n - k)} \frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}} = 1
\end{equation}
$$

This directly yields the result, or

$$
\begin{equation}
    \frac{N(N - k)}{k + 1} = \sum_{i = k}^{N - 1} \frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}
\end{equation}
$$
{% enddetails %}

Putting this all together, we get:

$$
\begin{align*}
    & \mathbb{E}[\text{Secretary chosen}] \\
    = & \frac{k}{2} + \sum_{i = k}^{N - 1}\frac{k}{N}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}\frac{i + 1 + N}{2} && \text{Equation (12)}\\
    = & \frac{k}{2} + \frac{k(N + 1)}{2N} \left(\sum_{i = k}^{N - 1}\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}\right) + \frac{k}{2N}\left(\sum_{i = k}^{N - 1}i\frac{\binom{i - 1}{k - 1}}{\binom{N - 1}{k - 1}}\right) \\
    = & \frac{k}{2} + \frac{k(N + 1)}{2N} \left(\frac{N - k}{k}\right) + \frac{k}{2N}\left(\frac{N(N - k)}{k + 1}\right) && \text{Equations (14) and (15)}\\
    = & \frac{k}{2} + \frac{N - k}{2}\left(\frac{N + 1}{N} + \frac{k}{k + 1}\right)
\end{align*}
$$

{% enddetails %}

Using the chain/quotient rules, the derivative with respect to $$k$$ works out to be 

$$
\begin{equation}
    \frac{\partial}{\partial k} \mathbb{E}[\text{Secretary chosen}] = \frac{1}{2} + \frac{-1}{2}\left(\frac{N + 1}{N} + \frac{k}{k + 1}\right) + \frac{N - k}{2}\frac{1}{(k + 1)^2}
\end{equation}
$$

Finally, we can set this to zero to and solve for $$k$$ to achieve a solution of 

$$
\begin{equation}
    k_{\text{opt}} = \sqrt{N} - 1
\end{equation}
$$

{% details Click here for fully worked out maxima calculation%}
$$
\begin{align*}
    & \frac{1}{2} + \frac{-1}{2}\left(\frac{N + 1}{N} + \frac{k}{k + 1}\right) + \frac{N - k}{2}\frac{1}{(k + 1)^2} = 0 \\
    \implies & \frac{N(k + 1)^2 - (N + 1)(k + 1)^2 - Nk(k + 1) + (N - k)N}{2N(k + 1)^2} = 0 \\
    \implies & N(k + 1)^2 - (N + 1)(k + 1)^2 - Nk(k + 1) + (N - k)N = 0 \\
    \implies & -(N + 1)k^2 - 2(N + 1)k - (1 - N^2) = 0 \\
    \implies & (N + 1)k^2 + 2(N + 1)k + (1 - N^2) = 0 \\
    \implies & k = \frac{-2(N + 1) \pm \sqrt{4(N + 1)^2 - 4(N + 1)(1 - N^2)}}{2(N + 1)} \\
    \implies & k = \frac{-2(N + 1) \pm 2(N + 1)\sqrt{1 - (1 - N)}}{2(N + 1)} \\
    \implies & k = -1 \pm \sqrt{N}
\end{align*}
$$

{% enddetails %}

Success! we now know that we should only reject the first $$\sqrt{N} - 1$$ secretaries, then pick the next one that is greater than all those we rejected. If this isn't a whole number, we can simply pick the closest integer to $$\sqrt{N} - 1$$<d-footnote>This is a result of the function being concave, see Bearden<d-cite key="bearden2006new"></d-cite> for more.</d-footnote> :smile:


### Visualizations/Intuition
In the original version of the problem, we had to reject the first $$\frac{N}{e}$$, or $$~34$$ percent of secretaries before beginning the next stage. This means that $$34$$ percent of the time, the top secretary is in the rejection group and the algorithm fails! When optimizing for only the top secretary, we have to pick a random secretary with a relatively low expected score over 1/3 of the time. 

This is more OK when the only goal is to try and maximize the probability of the highest secretary, but severely punishes our formulation where getting the second best secretary or third best is also a win. 
<div class="row mt-3">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/secretary_problem.png" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
Here we visualize the expected value for picking the rejection number at 1 through 100 for $$N = 100$$ as well as the probability of picking the best secretary. As predicted, the highest expected value is at $$k = \sqrt{100} - 1 = 9$$, with an expected secretary score of 91.405, which is pretty good!! At this value, the probability of picking the best secretary is only 21 percent, as opposed to the 36 percent which occurs if we wait 36 people instead of 9. Since we only wait for the first 9 secretaries, our algorithm "fails" and is forced to pick the last secretary only $$9$$ percent of the time.

A nicer formulation of the expected value is as follows:

$$
\begin{equation}
    (n + 1)\left(1 - \frac{k}{2n} - \frac{1}{2(k + 1)}\right)
\end{equation}
$$

Here, notice that if $$k$$ is too big, the first negative term will reduce the epxected value, while if $$k$$ is too small, the second negative term will reduce the expected value. 
