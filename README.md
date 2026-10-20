# Cubicore

What if you wished to make a "company" right at home, where you are the founder of the project, and your fellow sub-agents do the work for you?

Enter Cubicore, A Dynamic Multi-Agent Factory System that interacts with Sub-tasks and Sessions (if present). The system is designed as an MCP for enhanced portability across multiple AI agents - Opencode or Claude Code, to name a few.

## What is the idea?

Suppose you imagine a magic "cube", as an example. Act that this cube is a "mini" company that is under your control. Then, you ask the "magic cube" about what you want. It can be anything - even a multimillion SaaS product would be fine. After you reply to the "magic cube", the cube plans and determines the size of your project, and size of your project matters for how many "employees" that will be hired for this job.

Once its all set, the cube resizes and fills it with new "employees" to work on each task the "cube" has been told to provide. It also asks about what style or layout you really want, or maybe you can also ignore it to have the "cube" give the best style it can think of!

The project is done when all sub-tasks are done, but hey, you can even call the testers to test the product you made, just to make sure no bugs, broken interactions, fixable warnings are left behind. You can add any feature you wanted by asking the "magic cube" again, and it will do it for you. It doesn't matter how many decorations you add onto the "magic cube", it will always be better with its "add-ons".

## How it Works?

Like the Idea, Cubicore is the definition of "Cores in a Cubicle", which are called "Cubicores". These "cubicores" represents Inline Sub-tasks or Sessions run by the agent at the same time (it is never one-by-one). 

The Architecture of this idea works like below:

```
[User gives Prompt] --> [Agent Plans about the Prompt and generates file] --> [Summon Sub-agents to read generated file] --> [Submits Result]
```

When a user gives a prompt, assume it to be a simple, lazy prompt "Make me some huge a## project that can make me rich. make no mistakes, i believe in you.".
Using the prompt provided by the User, and Main agent will Plan and research about the project on what you are meaning to build... and will ask further questions about the type of product, the style, the layout, the tech stacks, anything... even the questions would be marked "Recommended" to be selected very easily.
After when its done, it finally determines the Project Size, displays the tasks, where each task (they are no small tasks) is assigned to a particular "cubicore". It also gives out the N number of cubicores required to build your project from scratch. This is all mentioned in the PLAN.md file for every "cubicore", even the "founder" (The user) to see. 

Once done, Hit the "execute" command - The Main agents summon the N "cubicores" as if its constructing an urgent megaproject. These sub-tasks fill in the gaps by finishing its tasks, and avoid conflicts with other workers in the process.

In the end, It finally gives the result you (the founder) wanted. You can try the "test" command to go even further, by asking the Main agent to summon testers for your project, to make sure all broken interactions, and errors, and fixable warnings are recorded in the DEBUG file. Again, anyone is free to see the DEBUG file, as it shows how many problems it has been encountered through the corners of your masterpiece.

After this, Run the "execute" command again, and it starts fixing the issues once again, same procedures as it was. Basically a "rinse-and-repeat", where you need to run "test" and "execute" commands until there is no DEBUG file, which your project is considered Ready for production.

About the "decorations", Cubicore is meant to have excellent support for plugins and MCPs that can assist the work with new and unique commands running, or possibly reducing tokens along the way. Regardless, it makes the Project even better, and doesnt waste anything.

## Supported AI Agents

Currently, we only support Opencode for now.

| AI Agent | Status | Progress |
| Opencode | ❌ | 45% |
| Claude Code | ❌ | 0% |
3. Codex
4. Cursor
5. Windsurf
6. Kilo Code

