package seed

var owls = Community{
	Description: "A late-night book and film club for people who read past their bedtime.",
	Accent:      "#f0a020",
	Members: []Member{
		{Username: "margot", Display: "Margot Lindqvist", Bio: "Started Night Owls after a decade of reading past midnight; Swedish crime novels are her guilty pleasure.", Emoji: "🦉", Status: "up past my bedtime", Role: "admin"},
		{Username: "desmond", Display: "Desmond Achebe", Bio: "Projectionist turned librarian who has logged every film he's seen since 1998.", Emoji: "🎞️", Status: "picking Friday's film", Role: "moderator"},
		{Username: "yuki", Display: "Yuki Tanaka", Bio: "Literary translator in Osaka who argues about translations in two languages.", Emoji: "📖", Status: "comparing Le Guin editions", Role: "moderator"},
		{Username: "rosa.m", Display: "Rosa Medina", Bio: "Pediatric ER doctor who reads on night shifts between patients.", Emoji: "🩺", Status: "on call"},
		{Username: "aleks", Display: "Aleksander Nowak", Bio: "Runs a bakery in Kraków and reads on the 4am tram.", Emoji: "🥐", Status: "proofing dough"},
		{Username: "hannah_b", Display: "Hannah Brooks", Bio: "Ecology grad student who recommends The Overstory to anyone standing still.", Emoji: "🌲", Status: "thesis chapter 4"},
		{Username: "omar", Display: "Omar Haddad", Bio: "Podcast audio engineer who reads almost everything as audiobooks at 1.25x.", Emoji: "🎧", Status: "listening to Le Guin"},
		{Username: "leilani", Display: "Leilani Kahale", Bio: "Writes poetry on Oʻahu's North Shore and posts the best recs in the club."},
		{Username: "theo", Display: "Theo Fischer", Bio: "Retired cinematographer with strong opinions about aspect ratios.", Emoji: "🎥", Status: "4:3 forever"},
		{Username: "ines", Display: "Inês Carvalho", Bio: "New parent in Lisbon reading in twenty-minute stretches during night feeds.", Emoji: "🍼", Status: "3am feed club"},
		{Username: "kwame", Display: "Kwame Mensah", Bio: "Software engineer in Accra who joined for the sci-fi and stayed for the films.", Emoji: "🚀", Status: "recovering from Kindred"},
	},
	Bot: Member{Username: "hoot", Display: "Hoot", Bio: "Posts a reading prompt in #nightly-prompt every night around 10. Answer in the thread."},
	Roles: []Role{
		{Name: "Film club", Color: "#c0392b", Members: []string{"desmond", "hannah_b", "ines", "kwame", "leilani", "omar", "rosa.m", "theo", "yuki"}},
		{Name: "Spoiler-safe", Color: "#8e44ad", Members: []string{"desmond", "hannah_b", "kwame", "leilani", "omar", "rosa.m", "theo", "yuki"}},
	},
	Channels: []Channel{
		{
			Name: "announcements", Topic: "Book of the month, film club schedule, polls.", Category: "General",
			Convos: []Convo{
				{DaysAgo: 13.95, Lines: []Line{
					{By: "margot", Text: "Welcome to October, owls 🦉 Book of the month is _The Left Hand of Darkness_ by Ursula K. Le Guin. Spoilers go in #spoilers-the-left-hand-of-darkness only. Film club is Fridays at 10pm.",
						React: map[string][]string{"❤️": {"desmond", "yuki", "kwame", "hannah_b", "leilani"}}},
				}},
				{DaysAgo: 7.7, Lines: []Line{
					{By: "margot", Text: "Reminder: Hoot posts a prompt every night around 10. Please answer in the thread so the channel stays readable.",
						React: map[string][]string{"👍": {"ines", "omar"}}},
				}},
				{DaysAgo: 1.5, Lines: []Line{
					{By: "margot", Text: "The poll for November's book is up! Reply in this thread with your vote: _The Dispossessed_, _Kindred_ or _Piranesi_.",
						Replies: []Line{
							{By: "kwame", Text: "The Dispossessed"},
							{By: "hannah_b", Text: "Piranesi!!"},
							{By: "rosa.m", Text: "Kindred. I want to reread it with all of you"},
							{By: "leilani", Text: "Piranesi"},
							{By: "aleks", Text: "Piranesi, I'm halfway through already so I'm biased"},
						}},
				}},
			},
		},
		{
			Name: "nightly-prompt", Topic: "Hoot's nightly question. Answer in the thread.", Category: "Reading",
			Convos: []Convo{
				{DaysAgo: 13.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: What's a book you read at the wrong age, too young or too old? Would you reread it now?",
						Replies: []Line{
							{By: "rosa.m", Text: "Catcher in the Rye at 30. I wanted to shake Holden. I think I'd be kinder to him now that I work with teenagers."},
							{By: "leilani", Text: "Little Women at 9. I skipped everything that wasn't Jo. Reread it last year and cried about Beth like an adult."},
							{By: "kwame", Text: "Dune at 12. I understood the sandworms and nothing else."},
							{By: "margot", Text: "@kwame honestly that's still 90% of the appeal"},
						}},
				}},
				{DaysAgo: 12.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: Which fictional place would you most like to spend one sleepless night in?",
						Replies: []Line{
							{By: "hannah_b", Text: "the House from Piranesi. walking the halls while the tides come in"},
							{By: "yuki", Text: "the café from _Before the Coffee Gets Cold_. I'd drink it fast though"},
							{By: "omar", Text: "the Hogwarts library, restricted section, no supervision"},
							{By: "ines", Text: "anywhere with a nursery that runs itself"},
						}},
				}},
				{DaysAgo: 11.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: Share a sentence you underlined recently, and tell us why it stopped you.",
						Replies: []Line{
							{By: "yuki", Text: "\"Whatever our souls are made of, his and mine are the same.\" Rereading Wuthering Heights in Japanese and it lands differently."},
							{By: "leilani", Text: "Mary Oliver: \"Tell me, what is it you plan to do / with your one wild and precious life?\" I've underlined it in three different copies."},
							{By: "desmond", Text: "From Gilead: \"There are a thousand thousand reasons to live this life, every one of them sufficient.\" Read it at 2am and had to put the book down.",
								React: map[string][]string{"❤️": {"margot", "rosa.m", "leilani", "ines"}}},
							{By: "margot", Text: "this is why I love this channel"},
						}},
				}},
				{DaysAgo: 10.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: A book everyone loves that you just couldn't finish. No shame here.",
						Replies: []Line{
							{By: "aleks", Text: "Infinite Jest. 200 pages in, the footnotes won"},
							{By: "theo", Text: "Moby-Dick. I respect the whale. I do not need the chapter about rope."},
							{By: "hannah_b", Text: "@theo the rope chapter is actually beautiful!! (I'm alone in this)"},
							{By: "kwame", Text: "The Name of the Wind. am I waiting for book 3 or am I free?"},
							{By: "margot", Text: "you are free, @kwame"},
						}},
				}},
				{DaysAgo: 9.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: A film adaptation that's better than the book. Go on, be brave.",
						Replies: []Line{
							{By: "desmond", Text: "The Godfather. I will die on this hill."},
							{By: "theo", Text: "Jaws. The book has a whole affair subplot nobody needed."},
							{By: "omar", Text: "No Country for Old Men is equal to the book, which might be the bigger compliment"},
							{By: "rosa.m", Text: "The Princess Bride. Fight me (gently)."},
						}},
				}},
				{DaysAgo: 8.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: When you can't sleep, do you read something new or something you know by heart?",
						Replies: []Line{
							{By: "ines", Text: "by heart. at 3am I need Anne of Green Gables, not surprises"},
							{By: "omar", Text: "new, but audio. a calm narrator puts me out in 15 minutes"},
							{By: "rosa.m", Text: "Terry Pratchett. any of them. it's like a warm bath"},
							{By: "margot", Text: "Moomins. I'm 47."},
							{By: "leilani", Text: "@margot Moominvalley in November is the perfect insomnia book"},
						}},
				}},
				{DaysAgo: 7.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: Which character would you want sitting next to you on a long night train?",
						Replies: []Line{
							{By: "kwame", Text: "Murderbot. it would ignore me and watch its shows and that's ideal"},
							{By: "rosa.m", Text: "Miss Marple. she'd knit and figure out everyone in the carriage by morning"},
							{By: "aleks", Text: "Samwise. he'd bring snacks"},
							{By: "yuki", Text: "Klara from Klara and the Sun. she'd notice the sunrise before anyone"},
							{By: "omar", Text: "@aleks Samwise is the correct answer, the rest of you can go home"},
						}},
				}},
				{DaysAgo: 6.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: Which book changed how you see an ordinary thing, like trees, food, or the sky?",
						Replies: []Line{
							{By: "hannah_b", Text: "The Overstory, obviously. I can't walk past a chestnut without apologizing to it"},
							{By: "leilani", Text: "Braiding Sweetgrass. I say thank you to the garden now"},
							{By: "aleks", Text: "Salt Fat Acid Heat. I've baked for 20 years and it still taught me things about salt"},
							{By: "kwame", Text: "Kindred. I think about family history very differently now"},
						}},
				}},
				{DaysAgo: 5.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: You can ask one author, living or dead, one question. Who, and what?",
						Replies: []Line{
							{By: "yuki", Text: "Ishiguro: did you know from page one what Stevens was hiding from himself?"},
							{By: "kwame", Text: "Octavia Butler: what were you planning after the Parables?"},
							{By: "desmond", Text: "Le Guin: would you write Genly any differently today?"},
							{By: "margot", Text: "Agatha Christie: how did you plot these? index cards? spite?",
								React: map[string][]string{"😂": {"desmond", "yuki", "aleks"}}},
						}},
				}},
				{DaysAgo: 4.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: A quiet book. Nothing much happens, and you loved it anyway.",
						Replies: []Line{
							{By: "ines", Text: "Stoner by John Williams. a whole life, very quietly, and it wrecked me"},
							{By: "theo", Text: "Perfect Days, if a film counts. A man cleans toilets and looks at trees."},
							{By: "yuki", Text: "@theo it counts. also _The Housekeeper and the Professor_"},
							{By: "rosa.m", Text: "Gilead again, sorry for copying you desmond"},
							{By: "desmond", Text: "@rosa.m Gilead is always allowed"},
						}},
				}},
				{DaysAgo: 3.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: What's on your nightstand right now?",
						Replies: []Line{
							{By: "aleks", Text: "Piranesi, a flour-dusted copy of Tartine Bread, and a phone charger"},
							{By: "hannah_b", Text: "The Hidden Life of Trees, Braiding Sweetgrass, and a very overdue library copy of Pachinko"},
							{By: "omar", Text: "no nightstand, just earbuds 🎧"},
							{By: "ines", Text: "a baby monitor and The Remains of the Day, bookmark on page 40 for three weeks"},
						}},
				}},
				{DaysAgo: 2.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: Pick a book for someone you love who \"doesn't read\". What would you hand them?",
						Replies: []Line{
							{By: "margot", Text: "The Martian. funny, fast, short chapters"},
							{By: "kwame", Text: "Project Hail Mary, same reasons, plus the best friendship in sci-fi"},
							{By: "leilani", Text: "a poetry collection. Ocean Vuong's _Night Sky with Exit Wounds_"},
							{By: "rosa.m", Text: "my brother only reads cookbooks, so Salt Fat Acid Heat, @aleks style"},
						}},
				}},
				{DaysAgo: 1.1, Lines: []Line{
					{By: "hoot", Text: "🦉 Tonight's prompt: Post the last line of the last book you finished, no context. Let's guess.",
						Replies: []Line{
							{By: "theo", Text: "\"So we beat on, boats against the current, borne back ceaselessly into the past.\""},
							{By: "desmond", Text: "@theo too easy. Gatsby"},
							{By: "ines", Text: "\"It is not often that someone comes along who is a true friend and a good writer. Charlotte was both.\" Reading it aloud to the baby. She is unimpressed."},
							{By: "margot", Text: "Charlotte's Web! now I'm crying at 11pm, thanks ines"},
						}},
				}},
			},
		},
		{
			Name: "now-reading", Topic: "What's open on your nightstand? Progress updates welcome. No spoilers for the book of the month here.", Category: "Reading",
			Convos: []Convo{
				{DaysAgo: 13.6, Lines: []Line{
					{By: "kwame", Text: "Started Kindred tonight. 30 pages in and I'm already stressed."},
					{By: "yuki", Text: "Butler doesn't waste a page. you're in for it"},
					{By: "kwame", Text: "the prologue is like two pages and it already got me"},
					{By: "rosa.m", Text: "Read it in two days last year. Hydrate."},
				}},
				{DaysAgo: 11.8, Lines: []Line{
					{By: "aleks", Text: "Piranesi on the tram this morning. I missed my stop because of a description of a statue"},
					{By: "hannah_b", Text: "the statues!! the faun one"},
					{By: "aleks", Text: "the House is so calm and so strange. I'm reading it slowly on purpose"},
					{By: "margot", Text: "that's the right way. it's a book that rewards going slow"},
				}},
				{DaysAgo: 9.6, Lines: []Line{
					{By: "ines", Text: "Remains of the Day update: still on page 40. not the book's fault. the baby's"},
					{By: "yuki", Text: "Ishiguro will wait for you. Stevens is very patient."},
					{By: "ines", Text: "😂 he would never complain about it, that's the whole problem"},
					{By: "desmond", Text: "the Merchant Ivory film with Anthony Hopkins is a lovely companion if you need a break"},
					{By: "ines", Text: "noted for 3am"},
				}},
				{DaysAgo: 7.4, Lines: []Line{
					{By: "omar", Text: "Finished Middlemarch on audio. 35 hours, Juliet Stevenson narrating. I feel like I moved to a small English town and came back older.",
						React: map[string][]string{"❤️": {"margot", "hannah_b", "leilani"}}},
					{By: "margot", Text: "that narration is legendary"},
					{By: "omar", Text: "Dorothea deserved better and George Eliot knew it"},
					{By: "hannah_b", Text: "the last paragraph is one of the most beautiful things in English"},
					{By: "omar", Text: "I listened to it twice in the car before going inside"},
				}},
				{DaysAgo: 4.6, Lines: []Line{
					{By: "hannah_b", Text: "Pachinko is so good it's making me late to the lab"},
					{By: "leilani", Text: "that first line! \"History has failed us, but no matter.\""},
					{By: "hannah_b", Text: "I said \"oh\" out loud on the bus"},
					{By: "theo", Text: "the TV series is gorgeous too, once you finish. the opening credits alone"},
				}},
				{DaysAgo: 2.5, Lines: []Line{
					{By: "kwame", Text: "Finished Kindred. I need a walk."},
					{By: "rosa.m", Text: "told you. hydrate."},
					{By: "kwame", Text: "what do I read next that won't wreck me"},
					{By: "yuki", Text: "Becky Chambers, _A Psalm for the Wild-Built_. a robot and a tea monk. pure comfort",
						React: map[string][]string{"🍵": {"kwame", "leilani"}}},
					{By: "kwame", Text: "a TEA MONK. sold"},
				}},
				{DaysAgo: 6.0, Lines: []Line{
					{By: "leilani", Text: "Reading Ocean Vuong's _On Earth We're Briefly Gorgeous_ again. it's a letter to his mother and every page is a poem"},
					{By: "yuki", Text: "the passage about the buffalo. I still think about it"},
					{By: "leilani", Text: "yes. I read that bit out loud to my sister on the phone"},
					{By: "hannah_b", Text: "adding it. I need more poetry in my life that isn't about soil"},
					{By: "leilani", Text: "soil poetry is valid, @hannah_b"},
				}},
				{DaysAgo: 0.4, Lines: []Line{
					{By: "theo", Text: "Started Station Eleven tonight. \"Survival is insufficient.\""},
					{By: "margot", Text: "you're going to love the traveling Shakespeare company"},
					{By: "theo", Text: "already do"},
				}},
			},
		},
		{
			Name: "recs", Topic: "Ask for or give recommendations. Books, films, anything with a story.", Category: "Reading",
			Convos: []Convo{
				{DaysAgo: 12.6, Lines: []Line{
					{By: "rosa.m", Text: "I need something for night shifts: absorbing, but fine to put down every 20 minutes. Ideas?",
						Replies: []Line{
							{By: "margot", Text: "short story collections! Ted Chiang's _Exhalation_"},
							{By: "omar", Text: "The Maid by Nita Prose. short chapters, cozy mystery"},
							{By: "ines", Text: "Mary Oliver. one poem per break"},
							{By: "rosa.m", Text: "Exhalation it is, thank you all"},
						}},
				}},
				{DaysAgo: 10.4, Lines: []Line{
					{By: "leilani", Text: "Rec of the week: _The Remains of the Day_, for anyone who likes stories about what people don't say."},
					{By: "yuki", Text: "seconding. one of the most perfectly controlled novels I know"},
					{By: "ines", Text: "currently reading! slowly"},
					{By: "leilani", Text: "slowly is how it wants to be read"},
				}},
				{DaysAgo: 7.8, Lines: []Line{
					{By: "desmond", Text: "Film rec: _Columbus_ (2017) by Kogonada. Architecture, grief, long quiet shots. Perfect 1am viewing.",
						React: map[string][]string{"👀": {"kwame", "hannah_b"}}},
					{By: "theo", Text: "the framing in that film. every shot could hang on a wall"},
					{By: "kwame", Text: "added to my list"},
				}},
				{DaysAgo: 5.3, Lines: []Line{
					{By: "kwame", Text: "Looking for sci-fi that's more about people than spaceships. Already loved Kindred and Le Guin."},
					{By: "yuki", Text: "Klara and the Sun"},
					{By: "hannah_b", Text: "The Dispossessed, more Le Guin"},
					{By: "leilani", Text: "Never Let Me Go. Ishiguro again, sorry"},
					{By: "kwame", Text: "my library list just doubled. thank you"},
					{By: "margot", Text: "@kwame The Dispossessed is the natural next step, trust me"},
				}},
				{DaysAgo: 3.5, Lines: []Line{
					{By: "omar", Text: "Audiobook recs where the narrator makes the book? I just finished Middlemarch and I'm spoiled now",
						Replies: []Line{
							{By: "kwame", Text: "Project Hail Mary, Ray Porter. the audio has a thing the print book can't do"},
							{By: "margot", Text: "Lincoln in the Bardo. a full cast of 166 voices"},
							{By: "rosa.m", Text: "anything by Neil Gaiman read by himself. the Graveyard Book is perfect for night shifts"},
							{By: "omar", Text: "three great picks, queued up"},
						}},
				}},
				{DaysAgo: 1.8, Lines: []Line{
					{By: "ines", Text: "Picture book recs for a tiny human who mostly chews them?"},
					{By: "aleks", Text: "The Very Hungry Caterpillar, board book. it's built for chewing"},
					{By: "rosa.m", Text: "Goodnight Moon. a classic for a reason"},
					{By: "ines", Text: "both ordered. she'll love eating them",
						React: map[string][]string{"😂": {"aleks", "rosa.m", "margot"}}},
				}},
			},
		},
		{
			Name: "spoilers-the-left-hand-of-darkness", Topic: "Full spoilers for this month's book. You've been warned.", Category: "Reading",
			Roles: []string{"Spoiler-safe"},
			Convos: []Convo{
				{DaysAgo: 13.3, Lines: []Line{
					{By: "margot", Text: "Spoiler channel is open! Talk about anything here, ending included."},
					{By: "yuki", Text: "finally. I've been holding in Estraven thoughts for a week"},
					{By: "margot", Text: "let them out"},
				}},
				{DaysAgo: 10.8, Lines: []Line{
					{By: "yuki", Text: "Estraven's first chapters read so differently once you know how it ends. Every kindness he shows Genly in Erhenrang, and Genly misreads all of it.",
						React: map[string][]string{"❤️": {"desmond", "kwame", "margot"}},
						Replies: []Line{
							{By: "desmond", Text: "the parade scene. Genly thinks he's being cold and he's actually trying to warn him"},
							{By: "kwame", Text: "I misread him too the first time. which I think is the point. we're as stuck in our assumptions as Genly is"},
							{By: "yuki", Text: "exactly. shifgrethor goes both ways"},
						}},
				}},
				{DaysAgo: 8.5, Lines: []Line{
					{By: "hannah_b", Text: "Can we talk about the crossing of the Gobrin Ice? Weeks of dragging a sledge, and it's the most tender part of the book."},
					{By: "rosa.m", Text: "when they finally mindspeak and Genly hears Estraven in his dead brother's voice. I had to put the book down"},
					{By: "margot", Text: "and the kemmer scene where they choose not to. so restrained"},
					{By: "hannah_b", Text: "Le Guin writing a love story by not writing a love story"},
					{By: "theo", Text: "the cold is written so well I put on a sweater"},
				}},
				{DaysAgo: 6.6, Lines: []Line{
					{By: "kwame", Text: "I'm still upset about Estraven skiing straight at the guards. on purpose."},
					{By: "desmond", Text: "and Genly calls the ship down right after. too late."},
					{By: "omar", Text: "listening to the audiobook in the car and I had to pull over"},
					{By: "yuki", Text: "and then the son asking Genly about the other worlds. that ending is a door left open"},
					{By: "margot", Text: "the saddest hopeful ending I know",
						React: map[string][]string{"😢": {"kwame", "yuki", "omar", "hannah_b"}}},
				}},
				{DaysAgo: 3.4, Lines: []Line{
					{By: "leilani", Text: "Hot take: the Orgoreyn chapters are the scariest in the book. the Voluntary Farm is so bureaucratic and calm about everything"},
					{By: "omar", Text: "polite cruelty is worse than the loud kind"},
					{By: "desmond", Text: "written in 1969 and it still feels current, which is depressing"},
					{By: "margot", Text: "great discussion all month, owls. the November poll goes up in #announcements soon"},
				}},
			},
		},
		{
			Name: "film-club", Topic: "Weekly watch, Fridays at 10pm. Debrief threads after.", Category: "Film",
			Roles: []string{"Film club"},
			Convos: []Convo{
				{DaysAgo: 13.7, Lines: []Line{
					{By: "desmond", Text: "This Friday: _Paris, Texas_ (1984). Wim Wenders, Harry Dean Stanton, Ry Cooder's slide guitar. Bring tissues."},
					{By: "theo", Text: "Robby Müller's cinematography. those greens and reds"},
					{By: "leilani", Text: "never seen it! excited"},
					{By: "omar", Text: "the soundtrack alone is worth it"},
				}},
				{DaysAgo: 11.3, Lines: []Line{
					{By: "desmond", Text: "Paris, Texas debrief. Thoughts?",
						React: map[string][]string{"❤️": {"leilani", "theo"}},
						Replies: []Line{
							{By: "leilani", Text: "the peep show monologue. I had to pause and breathe"},
							{By: "theo", Text: "the way Wenders keeps them on opposite sides of the glass. a reflection, a phone, never just one clean frame"},
							{By: "kwame", Text: "Harry Dean Stanton barely speaks for the first stretch and you can't look away"},
							{By: "omar", Text: "Ry Cooder improvised the score while watching the footage. you can hear it"},
							{By: "desmond", Text: "great discussion, everyone 🎞️"},
						}},
				}},
				{DaysAgo: 8.9, Lines: []Line{
					{By: "desmond", Text: "Friday: _In the Mood for Love_ (2000). Wong Kar-wai. Maggie Cheung's qipaos deserve their own credit."},
					{By: "yuki", Text: "the slow-motion noodle runs 😭"},
					{By: "theo", Text: "Christopher Doyle and Mark Lee Ping-bing. a masterclass in framing through doorways"},
					{By: "hannah_b", Text: "I've only seen clips. is it the one with the waltz music?"},
					{By: "desmond", Text: "Yumeji's Theme. you'll hear it in your sleep for a week"},
				}},
				{DaysAgo: 6.9, Lines: []Line{
					{By: "theo", Text: "In the Mood for Love thoughts: the whole film is about what isn't said, which pairs well with Remains of the Day honestly"},
					{By: "ines", Text: "oh, that's a good pairing"},
					{By: "yuki", Text: "Stevens and Mr. Chow should start a support group"},
					{By: "theo", Text: "neither would show up",
						React: map[string][]string{"😂": {"yuki", "ines", "margot", "desmond"}}},
				}},
				{DaysAgo: 5.5, Lines: []Line{
					{By: "kwame", Text: "Off-schedule question: has anyone seen _Arrival_? I watched it after finishing Le Guin and it scratched the same itch"},
					{By: "theo", Text: "Bradford Young shot it. so much grey fog and it's still warm somehow"},
					{By: "hannah_b", Text: "and it's based on a Ted Chiang story! _Story of Your Life_"},
					{By: "kwame", Text: "wait, the same Ted Chiang from rosa's night-shift book?"},
					{By: "rosa.m", Text: "the very same. it's in _Stories of Your Life and Others_, his first collection"},
					{By: "desmond", Text: "adding it to the film club shortlist for winter"},
				}},
				{DaysAgo: 4.3, Lines: []Line{
					{By: "desmond", Text: "Friday: _Perfect Days_ (2023). Wenders again, because we've earned something gentle."},
					{By: "margot", Text: "Kōji Yakusho is wonderful in it"},
					{By: "rosa.m", Text: "I'm on shift but I'll watch Saturday and catch up"},
				}},
				{DaysAgo: 2.7, Lines: []Line{
					{By: "desmond", Text: "Perfect Days debrief 🌳",
						Replies: []Line{
							{By: "rosa.m", Text: "watched it Saturday morning after a night shift and it felt like medicine"},
							{By: "theo", Text: "Wenders in 4:3 again. komorebi. I want to photograph trees now"},
							{By: "kwame", Text: "the cassettes! Lou Reed in a tiny van in Tokyo"},
							{By: "ines", Text: "that last long shot on his face. I cried on the couch at 6am"},
							{By: "desmond", Text: "best film club turnout yet, thank you all"},
						}},
				}},
				{DaysAgo: 0.2, Lines: []Line{
					{By: "desmond", Text: "Next Friday: _Past Lives_ or _Columbus_? Vote with 🍿 or 🏛️",
						React: map[string][]string{"🍿": {"leilani", "hannah_b", "rosa.m", "kwame"}, "🏛️": {"theo", "desmond"}}},
					{By: "theo", Text: "a lone voice for architecture"},
					{By: "hannah_b", Text: "Past Lives. I need to cry again"},
				}},
			},
		},
		{
			Name: "insomnia-lounge", Topic: "For the 3am crowd. Tea, cats, whatever's keeping you up.", Category: "Off-topic",
			Convos: []Convo{
				{DaysAgo: 13.9, Lines: []Line{
					{By: "ines", Text: "anyone else up? 3am feed. she's asleep on me and I can't move"},
					{By: "rosa.m", Text: "on shift, so technically yes"},
					{By: "omar", Text: "editing a podcast. 3am is when I fix the worst audio"},
					{By: "ines", Text: "good to have company 🦉"},
				}},
				{DaysAgo: 12.0, Lines: []Line{
					{By: "aleks", Text: "4am at the bakery. first croissants out. best smell in the world",
						React: map[string][]string{"🥐": {"hannah_b", "ines", "margot"}}},
					{By: "hannah_b", Text: "I'm awake writing my thesis and now I'm hungry. thanks aleks"},
					{By: "aleks", Text: "come by at 7 and they're yours"},
					{By: "hannah_b", Text: "I'm in Vermont, that's quite a commute"},
				}},
				{DaysAgo: 9.9, Lines: []Line{
					{By: "leilani", Text: "can't sleep so I wrote a poem about the moon over the water. it's bad. I love it"},
					{By: "margot", Text: "share!!"},
					{By: "leilani", Text: "_the tide pulls / the moon pulls / and I am pulled between / two bright tired things_",
						React: map[string][]string{"❤️": {"margot", "ines", "yuki", "omar", "rosa.m"}}},
					{By: "hannah_b", Text: "that's not bad at all"},
					{By: "yuki", Text: "I want to translate it. may I?"},
					{By: "leilani", Text: "@yuki I would love that"},
				}},
				{DaysAgo: 7.2, Lines: []Line{
					{By: "kwame", Text: "What tea do insomniacs drink? I need something that isn't coffee at 1am"},
					{By: "yuki", Text: "hojicha. roasted, low caffeine, cozy"},
					{By: "aleks", Text: "chamomile with honey, my grandmother's cure for everything"},
					{By: "rosa.m", Text: "rooibos. zero caffeine, tastes like a hug"},
					{By: "kwame", Text: "ordered all three. I am a tea person now"},
				}},
				{DaysAgo: 5.8, Lines: []Line{
					{By: "theo", Text: "my cat has decided 2am is playtime. he keeps bringing me socks."},
					{By: "ines", Text: "the sock tax 😂"},
					{By: "omar", Text: "my dog does the same with one specific slipper"},
					{By: "theo", Text: "it's always the left one. why the left one",
						React: map[string][]string{"😂": {"ines", "omar", "kwame"}}},
				}},
				{DaysAgo: 3.8, Lines: []Line{
					{By: "hannah_b", Text: "Thesis chapter 3 submitted at 2:47am 🎉",
						React: map[string][]string{"🎉": {"margot", "aleks", "rosa.m", "leilani", "yuki", "kwame", "ines"}}},
					{By: "margot", Text: "HANNAH"},
					{By: "aleks", Text: "virtual croissant for you"},
					{By: "hannah_b", Text: "you're all the best. going to sleep for a week"},
				}},
				{DaysAgo: 2.9, Lines: []Line{
					{By: "desmond", Text: "confession: I've rewatched the last 10 minutes of Paris, Texas three times this week at 1am"},
					{By: "theo", Text: "that's not a confession, that's good taste"},
					{By: "leilani", Text: "the house movies scene gets me every time"},
					{By: "desmond", Text: "the Super 8 one, yes. I should go to sleep"},
					{By: "theo", Text: "you won't"},
					{By: "desmond", Text: "I won't"},
				}},
				{DaysAgo: 1.3, Lines: []Line{
					{By: "ines", Text: "she slept 5 hours in a row. FIVE. I didn't know what to do with myself so I read 50 pages of Remains of the Day"},
					{By: "yuki", Text: "Stevens would approve of your discipline"},
					{By: "ines", Text: "he'd say something very formal about it and then look at the floor"},
				}},
				{DaysAgo: 0.05, Lines: []Line{
					{By: "omar", Text: "3am crew checking in. what's everyone reading tonight?"},
					{By: "kwame", Text: "A Psalm for the Wild-Built. it's perfect, thank you @yuki"},
					{By: "rosa.m", Text: "Exhalation, between patients"},
					{By: "theo", Text: "Station Eleven. the Traveling Symphony is my new favorite band"},
					{By: "ines", Text: "nothing, the baby is asleep and so am I, almost"},
				}},
			},
		},
		{
			Name: "mod-lounge", Topic: "Club planning. Mods only.", Category: "General",
			Private: true, Members: []string{"margot", "desmond", "yuki"},
			Convos: []Convo{
				{DaysAgo: 11.6, Lines: []Line{
					{By: "margot", Text: "Planning: November's poll goes up at the end of the month. Candidates so far are The Dispossessed, Kindred and Piranesi."},
					{By: "yuki", Text: "is Piranesi too short for a whole month?"},
					{By: "desmond", Text: "short is good. we have new parents and ER doctors in the club 😄"},
					{By: "margot", Text: "fair. keep all three"},
				}},
				{DaysAgo: 4.9, Lines: []Line{
					{By: "yuki", Text: "Small thing: someone posted an ending spoiler in #now-reading. I moved it to the spoiler channel and messaged them, they were lovely about it."},
					{By: "margot", Text: "thank you. maybe add a reminder to the topic?"},
					{By: "yuki", Text: "done, the #now-reading topic says it now"},
					{By: "desmond", Text: "👍"},
				}},
			},
		},
	},
	DMs: []DM{
		{
			Members: []string{"margot", "yuki"},
			Convos: []Convo{
				{DaysAgo: 9.2, Lines: []Line{
					{By: "margot", Text: "would you lead the Le Guin wrap-up call on the 28th? your translation notes are always the best part"},
					{By: "yuki", Text: "I'd love to. can I bring a few comparisons with the Japanese edition?"},
					{By: "margot", Text: "please do"},
					{By: "yuki", Text: "I'll prepare three passages 📖"},
				}},
				{DaysAgo: 0.7, Lines: []Line{
					{By: "yuki", Text: "passages are ready. one is the Gobrin Ice chapter, where the translator made a very bold choice"},
					{By: "margot", Text: "ooh, bold how?"},
					{By: "yuki", Text: "you'll see on the 28th 😌"},
					{By: "margot", Text: "a tease! I love it"},
					{By: "yuki", Text: "I learned from the best"},
				}},
			},
		},
		{
			Members: []string{"rosa.m", "ines"},
			Convos: []Convo{
				{DaysAgo: 8.4, Lines: []Line{
					{By: "ines", Text: "how did you survive the newborn nights with your first?"},
					{By: "rosa.m", Text: "audiobooks in one earbud, and lowering every standard I had"},
					{By: "ines", Text: "the second part I've got down"},
					{By: "rosa.m", Text: "you're doing great. really."},
					{By: "ines", Text: "🥹 thank you"},
				}},
				{DaysAgo: 2.2, Lines: []Line{
					{By: "rosa.m", Text: "how's the sleep?"},
					{By: "ines", Text: "5 hours last night!"},
					{By: "rosa.m", Text: "huge!!"},
				}},
			},
		},
		{
			Members: []string{"desmond", "theo", "kwame"},
			Convos: []Convo{
				{DaysAgo: 6.3, Lines: []Line{
					{By: "desmond", Text: "programming question: a Wenders double feature someday? Wings of Desire, then Paris, Texas again"},
					{By: "theo", Text: "only if we start at 9. Wings of Desire is long"},
					{By: "kwame", Text: "I've never seen it. I'm in"},
					{By: "desmond", Text: "noting it for December"},
				}},
			},
		},
	},
}
